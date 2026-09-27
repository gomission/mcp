// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Licensed under Apache-2.0. See LICENSE.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { classifyToolCall, shouldBlock } from "../src/proxy-classify.mjs";
import { Proxy } from "../src/proxy.mjs";

test("security: read verbs cannot downgrade compound consequential tool names", () => {
  const cases = [
    ["get_or_create_event", "calendar.create"],
    ["get_and_send_email", "email.send.external"],
    ["list_and_invite_attendees", "calendar.create"],
    ["get_and_post_to_linkedin", "social.post.public"],
  ];

  for (const [toolName, actionClass] of cases) {
    const classification = classifyToolCall({
      toolName,
      args: { to: "reviewer@example.com" },
    });
    assert.equal(classification.action_class, actionClass, toolName);
    assert.equal(shouldBlock(classification), true, toolName);
  }
});

test("security: ordinary read tools remain low risk", () => {
  for (const toolName of ["get_event", "list_emails", "search_social_posts", "read_file"]) {
    const classification = classifyToolCall({ toolName, args: {} });
    assert.equal(classification.action_class, "read.context", toolName);
    assert.equal(shouldBlock(classification), false, toolName);
  }

  const lookupByEmail = classifyToolCall({
    toolName: "get_user_by_email",
    args: { email: "reviewer@example.com" },
  });
  assert.equal(lookupByEmail.action_class, "read.context");
  assert.equal(shouldBlock(lookupByEmail), false);
});

test("security: get_receipt cannot read JSON outside the receipt directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gomission-receipt-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.json"), JSON.stringify({ secret: "must-not-leak" }));

  const traversal = path.relative(
    path.join(workspace, "receipts"),
    path.join(outside, "secret"),
  ).split(path.sep).join("/");
  const proxy = new Proxy({ workspace, children: [] });
  const result = await proxy.callBuiltin("get_receipt", { receipt_id: traversal });
  const text = result.content.map((entry) => entry.text || "").join("\n");

  assert.match(text, /invalid receipt id/i);
  assert.doesNotMatch(text, /must-not-leak/);
});

test("security: get_receipt rejects symbolic links outside the receipt directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gomission-receipt-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const receipts = path.join(workspace, "receipts");
  const outside = path.join(root, "outside-secret.json");
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(outside, JSON.stringify({ secret: "must-not-leak" }));
  fs.symlinkSync(outside, path.join(receipts, "gm-symlink.json"));

  const proxy = new Proxy({ workspace, children: [] });
  const result = await proxy.callBuiltin("get_receipt", { receipt_id: "gm-symlink" });
  const text = result.content.map((entry) => entry.text || "").join("\n");

  assert.match(text, /invalid receipt file/i);
  assert.doesNotMatch(text, /must-not-leak/);
});

test("security: standalone get_receipt rejects traversal and symlinks while preserving valid reads", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gomission-standalone-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const receipts = path.join(workspace, "receipts");
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(root, "outside.json"), '{"secret":"must-not-leak"}');
  fs.writeFileSync(path.join(receipts, "gm-valid.json"), '{"receipt":"expected-valid-receipt"}');
  fs.symlinkSync(path.join(root, "outside.json"), path.join(receipts, "gm-symlink.json"));
  const calls = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "security-test", version: "1" } } },
    ...["../../outside", "gm-symlink", "gm-valid"].map((receipt_id, index) => ({
      jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: "get_receipt", arguments: { receipt_id } },
    })),
  ];
  const moduleUrl = new URL("../src/serve.mjs", import.meta.url).href;
  const script = `import {startServer} from ${JSON.stringify(moduleUrl)}; await startServer({workspace:${JSON.stringify(workspace)}});`;
  const processResult = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: calls.map(call => JSON.stringify(call)).join("\n") + "\n", encoding: "utf8", timeout: 5000,
  });
  assert.ifError(processResult.error);
  const replies = processResult.stdout.trim().split("\n").map(line => JSON.parse(line));
  const response = id => JSON.stringify(replies.find(reply => reply.id === id));
  assert.match(response(2), /invalid receipt id/i);
  assert.match(response(3), /invalid receipt file/i);
  assert.doesNotMatch(processResult.stdout, /must-not-leak/);
  assert.match(response(4), /expected-valid-receipt/);
});
