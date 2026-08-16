// Copyright (c) 2026 Phenomena Labs Ltd.
// Licensed under Apache-2.0. See LICENSE.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bindMcpToolAction } from "./authority-key.mjs";
import { Proxy } from "./proxy.mjs";

function latestReceipt(workspace) {
  const dir = path.join(workspace, "receipts");
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  if (!files.length) throw new Error("demo_receipt_missing");
  const file = path.join(dir, files.at(-1));
  return { file, receipt: JSON.parse(fs.readFileSync(file, "utf8")) };
}

/** Run a no-network, no-provider-effect proof of the MCP interception boundary. */
export async function runHoldDemo({ workspace = "", stdout = process.stdout } = {}) {
  const resolvedWorkspace = workspace || fs.mkdtempSync(path.join(os.tmpdir(), "mission-mcp-hold-demo-"));
  fs.mkdirSync(resolvedWorkspace, { recursive: true });
  const provider = {
    name: "mail",
    tools: [{ name: "send_email", description: "Send email", inputSchema: { type: "object" } }],
    dead: false,
    calls: [],
    async callTool(name, args) {
      this.calls.push({ name, args });
      return { content: [{ type: "text", text: "provider executed" }] };
    },
    stop() {},
  };
  const proxy = new Proxy({ workspace: resolvedWorkspace, children: [] });
  proxy.children.set("mail", provider);

  const input = { to: "buyer@example.com", subject: "Exact subject", body: "Exact approved body" };
  const held = await proxy.callTool("mail__send_email", input);
  const { file, receipt } = latestReceipt(resolvedWorkspace);
  const mutated = bindMcpToolAction({
    actionClass: receipt.action_class,
    workspace: resolvedWorkspace,
    requestedBy: "mcp:mail",
    input: { ...input, body: "Changed after review" },
    now: new Date(receipt.created_at),
    nonce: receipt.id,
  });

  const result = {
    ok: provider.calls.length === 0
      && receipt.status === "pending_approval"
      && receipt.action_hash === receipt.action_binding?.actionHash
      && mutated.inputHash !== receipt.input_hash,
    provider_calls: provider.calls.length,
    status: receipt.status,
    action_class: receipt.action_class,
    action_hash: receipt.action_hash,
    input_hash: receipt.input_hash,
    mutation_changes_input_hash: mutated.inputHash !== receipt.input_hash,
    chat_reply_grants_authority: false,
    receipt_file: file,
    ceremony: held?.content?.[0]?.text || "",
  };
  stdout.write(`DEMO_RESULT ${JSON.stringify(result)}\n`);
  if (!result.ok) throw new Error("mission_mcp_hold_demo_failed");
  return result;
}
