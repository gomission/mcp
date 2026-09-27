import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(packageRoot, "bin/gomission-mcp.mjs");

function run(t, requests, cliArgs = ["serve"]) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mission-stable-cli-")));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    "--experimental-permission", `--allow-fs-read=${packageRoot}`,
    `--allow-fs-read=${workspace}`, `--allow-fs-write=${workspace}`,
    cli, ...cliArgs,
  ], {
    cwd: workspace, env: { PATH: process.env.PATH, MISSION_WORKSPACE: workspace },
    input: requests.map((r) => JSON.stringify({ jsonrpc: "2.0", ...r })).join("\n") + "\n",
    encoding: "utf8", timeout: 6000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

for (const [requested, expected] of [["2025-11-25", "2025-11-25"], ["2024-11-05", "2024-11-05"], ["2026-07-28", "2025-11-25"]]) {
  test(`stable CLI preserves initialize negotiation ${requested} -> ${expected} and its five tools`, (t) => {
    const responses = run(t, [
      { id: 1, method: "initialize", params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: "synthetic-compatibility", version: "1" } } },
      { id: 2, method: "tools/list" },
    ]).split("\n").map(JSON.parse);
    assert.equal(responses[0].result.protocolVersion, expected);
    assert.equal(responses[0].result.serverInfo.version, "0.2.3");
    assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ["mission_status", "request_approval", "log_action", "get_receipt", "mission_ask"]);
    assert.match(responses[1].result.tools.find((tool) => tool.name === "mission_ask").description, /currently unavailable/);
  });
}

test("stable CLI still rejects requests before initialize", (t) => {
  const response = JSON.parse(run(t, [{ id: 1, method: "tools/list" }]));
  assert.equal(response.error.code, -32002);
});

test("CLI package version matches the 0.2.3 patch release", (t) => {
  assert.equal(run(t, [], ["--version"]), "0.2.3");
});
