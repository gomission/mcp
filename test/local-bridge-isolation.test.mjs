import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(packageRoot, "bin", "gomission-mcp.mjs");

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mission-bridge-test-")));
  const selected = path.join(root, "selected");
  const other = path.join(root, "other");
  fs.mkdirSync(selected);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(selected, "mission.json"), JSON.stringify({ name: "Synthetic selected workspace" }));
  fs.writeFileSync(path.join(other, "mission.json"), JSON.stringify({ name: "Synthetic other workspace" }));
  const requests = [];
  const state = { workspace: selected };
  let responder = (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(state));
  };
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    responder(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const port = String(server.address().port);
  return { root, selected, other, requests, state, port, url: `http://127.0.0.1:${port}`, respond: (fn) => { responder = fn; } };
}

async function tool(f, { env = {}, method = "mission_ask", args = { query: "SYNTHETIC PRIVATE QUERY" }, cliWorkspace = f.selected } = {}) {
  // The actual CLI runs with filesystem permissions restricted to this package
  // and fixture. Home-directory usage stats and Claude discovery cannot access
  // real user data. No HOME override, credentials, or inherited Mission config.
  const child = spawn(process.execPath, [
    "--experimental-permission",
    `--allow-fs-read=${packageRoot}`,
    `--allow-fs-read=${f.root}`,
    `--allow-fs-write=${f.root}`,
    cli, "serve", "--workspace", cliWorkspace,
  ], {
    cwd: f.root,
    env: { PATH: process.env.PATH, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  let response;
  let failure;
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { failure = new Error("MCP fixture timed out"); child.kill(); }, 6000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n").slice(0, -1)) {
        const parsed = JSON.parse(line);
        if (parsed.id === 2) { response = parsed; child.kill(); }
      }
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (!response) reject(new Error(`MCP fixture exited without response: ${errors}`));
      else resolve(response);
    });
  });
  child.stdin.on("error", () => {});
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-security-test", version: "1" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: method, arguments: args } })}\n`);
  const message = await completed;
  assert.equal(message.error, undefined, JSON.stringify(message));
  return message.result.content.map((item) => item.text || "").join("\n");
}

test("local chat requires an explicit environment workspace and explicit listener; there is no default port", async (t) => {
  const f = await fixture(t);
  assert.match(await tool(f, { env: { MISSION_LOCAL_URL: f.url } }), /Set MISSION_WORKSPACE/);
  assert.match(await tool(f, { env: { MISSION_WORKSPACE: f.selected } }), /No default port/);
  assert.equal(f.requests.length, 0);
});

test("invalid or conflicting workspace selection fails before any request", async (t) => {
  const f = await fixture(t);
  for (const selected of ["selected", path.join(f.root, "missing"), path.join(f.selected, "mission.json"), f.other]) {
    assert.match(await tool(f, { env: { MISSION_WORKSPACE: selected, MISSION_LOCAL_URL: f.url } }), /Local Mission chat is unavailable/);
  }
  assert.equal(f.requests.length, 0);
});

test("only explicit loopback origins with a port are allowed, without redirect or credential syntax", async (t) => {
  const f = await fixture(t);
  for (const url of [
    "http://example.invalid:8814", "http://localhost:8814", "http://127.0.0.1", "http://127.0.0.1:0",
    "http://127.0.0.1:65536", "http://2130706433:8814", "http://127.1:8814", "file:///tmp/mission",
    f.url + "/path", f.url + "?foo=bar", f.url + "#fragment", f.url.replace("//", "//user:secret@"),
  ]) {
    assert.match(await tool(f, { env: { MISSION_WORKSPACE: f.selected, MISSION_LOCAL_URL: url } }), /explicit loopback URL and port/);
  }
  assert.match(await tool(f, { env: { MISSION_WORKSPACE: f.selected, MISSION_LOCAL_URL: f.url, MISSION_LOCAL_PORT: "1" } }), /must agree/);
  assert.equal(f.requests.length, 0);
});

test("another server's workspace identity is rejected without disclosing its path or sending the query", async (t) => {
  const f = await fixture(t);
  f.state.workspace = f.other;
  const result = await tool(f, { env: { MISSION_WORKSPACE: f.selected, MISSION_LOCAL_URL: f.url } });
  assert.match(result, /different workspace/);
  assert.ok(!result.includes(f.other));
  assert.deepEqual(f.requests.map(({ method, url }) => ({ method, url })), [{ method: "GET", url: "/api/state?active_view=1" }]);
});

test("workspace identity must be an existing absolute path string", async (t) => {
  const f = await fixture(t);
  for (const identity of [null, { path: f.selected }, "selected", path.join(f.root, "missing")]) {
    f.state.workspace = identity;
    assert.match(await tool(f, { env: { MISSION_WORKSPACE: f.selected, MISSION_LOCAL_URL: f.url } }), /workspace identity/);
  }
  assert.ok(f.requests.every(({ method, url }) => method === "GET" && url === "/api/state?active_view=1"));
});

test("redirects are not followed even to another loopback path", async (t) => {
  const f = await fixture(t);
  f.respond((req, res) => { res.writeHead(302, { location: f.url + "/other-target" }); res.end(); });
  assert.match(await tool(f, { env: { MISSION_WORKSPACE: f.selected, MISSION_LOCAL_URL: f.url } }), /Redirects are not followed/);
  assert.equal(f.requests.length, 1);
});

test("matching realpaths allow only an identity probe: no query, global token, or cookie is sent", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "alias");
  fs.symlinkSync(f.selected, alias);
  f.state.workspace = alias;
  const result = await tool(f, { env: {
    MISSION_WORKSPACE: f.selected, MISSION_LOCAL_URL: f.url,
    MISSION_API_TOKEN: "SYNTHETIC_GLOBAL_TOKEN", GOMISSION_TOKEN: "SYNTHETIC_REMOTE_TOKEN",
  } });
  assert.match(result, /workspace-scoped authentication handoff/);
  assert.match(result, /No query was sent/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, "GET");
  assert.equal(f.requests[0].headers.authorization, undefined);
  assert.equal(f.requests[0].headers["x-mission-api-token"], undefined);
  assert.equal(f.requests[0].headers.cookie, undefined);
  assert.doesNotMatch(JSON.stringify(f.requests), /SYNTHETIC/);
});

test("an explicit port is supported but status does not falsely advertise working chat", async (t) => {
  const f = await fixture(t);
  const result = await tool(f, { method: "mission_status", env: { MISSION_WORKSPACE: f.selected, MISSION_LOCAL_PORT: f.port } });
  assert.match(result, /workspace identity matches/);
  assert.match(result, /Local chat is unavailable/);
  assert.doesNotMatch(result, /mission_ask is wired/);
  assert.equal(f.requests.length, 1);
});

test("HTTP failure bodies and malformed JSON do not enter tool results", async (t) => {
  const f = await fixture(t);
  f.respond((req, res) => { res.writeHead(401); res.end("SYNTHETIC_PRIVATE_BODY"); });
  const first = await tool(f, { env: { MISSION_WORKSPACE: f.selected, MISSION_LOCAL_URL: f.url } });
  assert.match(first, /did not return a workspace identity/);
  assert.doesNotMatch(first, /SYNTHETIC_PRIVATE_BODY/);
  f.respond((req, res) => { res.writeHead(200); res.end("not json"); });
  assert.match(await tool(f, { env: { MISSION_WORKSPACE: f.selected, MISSION_LOCAL_URL: f.url } }), /invalid workspace identity/);
});

test("advisory receipt tools still work without local chat configuration", async (t) => {
  const f = await fixture(t);
  assert.match(await tool(f, { method: "log_action", args: { action_class: "internal_note", summary: "Synthetic local note" } }), /Logged internal action/);
  const receipts = fs.readdirSync(path.join(f.selected, "receipts"));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.selected, "receipts", receipts[0]), "utf8"));
  assert.equal(receipt.summary, "Synthetic local note");
  assert.equal(f.requests.length, 0);
});
