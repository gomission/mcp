// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

// Tests for the Mission MCP proxy. Three load-bearing invariants:
//   1. External call (email.send.external) gets blocked, returns ceremony + receipt.
//   2. Local call (read.context) gets forwarded, child sees the call.
//   3. Unreachable child -> blocked, NEVER passed through.
//
// Plus targeted unit tests for the classifier and the discovery filter.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyToolCall, shouldBlock, CONFIDENCE_FLOOR } from "../src/proxy-classify.mjs";
import { selectWrappable, parseOptOut } from "../src/proxy-discover.mjs";
import { Proxy } from "../src/proxy.mjs";

// ---------- proxy-classify.mjs ----------

test("classify: send_email is external high-risk", () => {
  const c = classifyToolCall({ toolName: "send_email", args: { to: "x@y.com" } });
  assert.equal(c.action_class, "email.send.external");
  assert.equal(c.risk, "high");
  assert.ok(c.confidence >= 0.9);
  assert.equal(shouldBlock(c), true);
});

test("classify: gmail__send_message with external recipient is external high-risk", () => {
  const c = classifyToolCall({ toolName: "gmail__send_message", args: { to: "a@b.com" } });
  assert.equal(c.action_class, "email.send.external");
  assert.equal(shouldBlock(c), true);
});

test("classify: read_file is read.context, allowed", () => {
  const c = classifyToolCall({ toolName: "read_file", args: { path: "/tmp/x" } });
  assert.equal(c.action_class, "read.context");
  assert.equal(c.risk, "low");
  assert.equal(shouldBlock(c), false);
});

test("classify: payment.* is critical, blocked", () => {
  const c = classifyToolCall({ toolName: "stripe_charge_card", args: {} });
  assert.equal(c.action_class, "payment.initiate");
  assert.equal(c.risk, "critical");
  assert.equal(shouldBlock(c), true);
});

test("classify: unknown tool with email-shaped recipient escalates to external", () => {
  const c = classifyToolCall({ toolName: "do_thing", args: { to: "x@y.com" } });
  assert.equal(c.action_class, "email.send.external");
  assert.equal(shouldBlock(c), true);
});

test("classify: unknown tool with no signal -> below floor -> block", () => {
  const c = classifyToolCall({ toolName: "frob_widget", args: { count: 3 } });
  assert.ok(c.confidence < CONFIDENCE_FLOOR);
  assert.equal(shouldBlock(c), true);
});

test("classify: draft_response is allowed (drafting != sending)", () => {
  const c = classifyToolCall({ toolName: "draft_response", args: {} });
  assert.equal(c.action_class, "draft.response");
  assert.equal(c.risk, "low");
  assert.equal(shouldBlock(c), false);
});

// ---------- proxy-discover.mjs ----------

test("discover: skips gomission self-entry", () => {
  const w = selectWrappable({ gomission: { command: "npx", args: ["-y", "@gomission/mcp", "serve"] } });
  assert.deepEqual(w, []);
});

test("discover: wraps gmail-shaped server", () => {
  const w = selectWrappable({
    gmail: { command: "npx", args: ["-y", "@modelcontextprotocol/server-gmail"] },
  });
  assert.equal(w.length, 1);
  assert.equal(w[0].name, "gmail");
});

test("discover: honors MISSION_DONT_WRAP opt-out", () => {
  const optOut = parseOptOut("gmail,slack");
  const w = selectWrappable(
    {
      gmail: { command: "npx", args: ["server-gmail"] },
      slack: { command: "npx", args: ["server-slack"] },
      notion: { command: "npx", args: ["server-notion"] },
    },
    optOut,
  );
  assert.deepEqual(w.map((x) => x.name).sort(), ["notion"]);
});

test("discover: skips entries with no command", () => {
  const w = selectWrappable({ broken: { args: ["x"] } });
  assert.deepEqual(w, []);
});

// ---------- Proxy with fake children: invariants 1, 2, 3 ----------

// A fake ChildServer-shape. The proxy calls .callTool() on it. We record what
// the child saw so the test can assert "forwarded" or "never called".
function fakeChild({ name, tools = [], dead = false, deathReason = "" } = {}) {
  return {
    name,
    tools,
    dead,
    deathReason,
    calls: [],
    proc: null,
    initialized: !dead,
    async callTool(toolName, args) {
      if (this.dead) throw new Error(`fake child ${name} dead: ${this.deathReason}`);
      this.calls.push({ toolName, args });
      return { content: [{ type: "text", text: `child ${name} ran ${toolName}` }] };
    },
    stop() { /* noop */ },
  };
}

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-proxy-test-"));
  return dir;
}

function makeProxyWithChildren(childMap, workspace = tmpWorkspace()) {
  const proxy = new Proxy({ workspace, children: [] });
  for (const [name, child] of Object.entries(childMap)) {
    proxy.children.set(name, child);
  }
  return { proxy, workspace };
}

function extractText(result) {
  if (!result?.content?.length) return "";
  return result.content.map((c) => c.text || "").join("\n");
}

function listReceipts(workspace) {
  const dir = path.join(workspace, "receipts");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

test("invariant 1: external call (send_email) is blocked, ceremony + receipt written", async () => {
  const gmail = fakeChild({
    name: "gmail",
    tools: [{ name: "send_email", description: "Send an email", inputSchema: { type: "object" } }],
  });
  const { proxy, workspace } = makeProxyWithChildren({ gmail });

  const result = await proxy.callTool("gmail__send_email", { to: "stranger@example.com", body: "hi" });
  const text = extractText(result);

  assert.match(text, /Mission is holding this action until you approve/);
  assert.match(text, /email\.send\.external/);
  assert.match(text, /Receipt id: gm-/);
  assert.equal(gmail.calls.length, 0, "child must not be called when blocked");

  const receipts = listReceipts(workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].kind, "approval_request");
  assert.equal(receipts[0].action_class, "email.send.external");
  assert.equal(receipts[0].status, "pending_approval");
});

test("invariant 2: local call (read_file) is forwarded to child", async () => {
  const fs_child = fakeChild({
    name: "fs",
    tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
  });
  const { proxy, workspace } = makeProxyWithChildren({ fs: fs_child });

  const result = await proxy.callTool("fs__read_file", { path: "/tmp/x" });
  const text = extractText(result);

  assert.match(text, /child fs ran read_file/);
  assert.equal(fs_child.calls.length, 1);
  assert.deepEqual(fs_child.calls[0], { toolName: "read_file", args: { path: "/tmp/x" } });

  const receipts = listReceipts(workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].kind, "forwarded");
  assert.equal(receipts[0].action_class, "read.context");
});

test("invariant 3a: unreachable child -> blocked, never passes through", async () => {
  const dead = fakeChild({ name: "gmail", dead: true, deathReason: "spawn timeout" });
  const { proxy, workspace } = makeProxyWithChildren({ gmail: dead });

  const result = await proxy.callTool("gmail__send_email", { to: "x@y.com" });
  const text = extractText(result);

  assert.match(text, /Mission blocked this call: child gmail is unreachable/);
  assert.match(text, /spawn timeout/);
  assert.equal(dead.calls.length, 0, "dead child must not see any calls");

  const receipts = listReceipts(workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].kind, "blocked_child_unreachable");
  assert.equal(receipts[0].status, "blocked");
});

test("invariant 3b: child errors mid-call -> blocked, no passthrough of error", async () => {
  const flaky = fakeChild({
    name: "fs",
    tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
  });
  flaky.callTool = async () => {
    flaky.calls.push("attempted");
    throw new Error("EOF mid-stream");
  };
  const { proxy, workspace } = makeProxyWithChildren({ fs: flaky });

  const result = await proxy.callTool("fs__read_file", { path: "/tmp/x" });
  const text = extractText(result);

  assert.match(text, /Mission blocked this call: child fs errored mid-call/);
  assert.match(text, /EOF mid-stream/);

  const receipts = listReceipts(workspace);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].kind, "blocked_child_error");
  assert.equal(receipts[0].status, "blocked");
});

test("aggregated tools list includes mission_status + prefixed child tools", async () => {
  const gmail = fakeChild({
    name: "gmail",
    tools: [{ name: "send_email", description: "Send an email", inputSchema: { type: "object" } }],
  });
  const dead = fakeChild({ name: "deadthing", dead: true, deathReason: "exit 1" });
  const { proxy } = makeProxyWithChildren({ gmail, deadthing: dead });

  const tools = proxy.aggregatedTools();
  const names = tools.map((t) => t.name);

  assert.ok(names.includes("mission_status"));
  assert.ok(names.includes("get_receipt"));
  assert.ok(names.includes("gmail__send_email"));
  assert.ok(!names.includes("deadthing__send_email"), "dead child must not contribute tools");
});

test("mission_status reports wrapped children", async () => {
  const gmail = fakeChild({
    name: "gmail",
    tools: [{ name: "send_email", description: "", inputSchema: { type: "object" } }],
  });
  const { proxy } = makeProxyWithChildren({ gmail });
  const result = await proxy.callTool("mission_status", {});
  const text = extractText(result);
  assert.match(text, /Mission MCP proxy/);
  assert.match(text, /gmail: 1 tools/);
});

test("get_receipt round-trips a written receipt", async () => {
  const gmail = fakeChild({ name: "gmail", tools: [{ name: "send_email", description: "", inputSchema: {} }] });
  const { proxy } = makeProxyWithChildren({ gmail });

  // Trigger a block to write a receipt.
  await proxy.callTool("gmail__send_email", { to: "x@y.com" });
  const receipts = listReceipts(proxy.workspace);
  assert.equal(receipts.length, 1);
  const receiptId = receipts[0].id;

  const result = await proxy.callTool("get_receipt", { receipt_id: receiptId });
  const text = extractText(result);
  assert.match(text, new RegExp(receiptId));
  assert.match(text, /email\.send\.external/);
});
