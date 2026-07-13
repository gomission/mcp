// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

// Mission MCP proxy. Wraps one or more downstream MCP servers (e.g.,
// Gmail, Slack, Notion) and gates their consequential tool calls through
// Trust Graduation. Speaks MCP 2025-11-25 (with backwards-compatible
// negotiation to 2024-11-05) to the parent (Claude) and to each spawned
// child server over newline-delimited JSON-RPC.
//
// Architecture invariants:
//   1. tools/list aggregates child tools under prefixed names: "<child>__<tool>".
//   2. tools/call: classify -> block (ceremony + receipt) or forward to child.
//   3. Child unreachable or errors during a call -> block. Never pass through.
//   4. The proxy itself exposes mission_status and get_receipt for visibility.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { classifyToolCall, shouldBlock } from "./proxy-classify.mjs";
import { discoverFromClaudeConfig } from "./proxy-discover.mjs";
import { negotiateProtocolVersion, PREFERRED_PROTOCOL_VERSION, isSupportedProtocolVersion } from "./protocol.mjs";

const VERSION = "0.1.0";
const PROTOCOL_VERSION = PREFERRED_PROTOCOL_VERSION;
const TOOL_DELIMITER = "__";
const CHILD_SPAWN_TIMEOUT_MS = 8000;
const CHILD_CALL_TIMEOUT_MS = 60000;

function resolveWorkspace(explicit = process.env.MISSION_WORKSPACE || "") {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, ".mission-workspace.json"))) return cwd;
  const fallback = path.join(os.homedir(), ".gomission-mcp");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function receiptsDir(workspace) {
  const dir = path.join(workspace, "receipts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newReceiptId() {
  return `gm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeReceipt(workspace, receipt) {
  const file = path.join(receiptsDir(workspace), `${receipt.id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return file;
}

function blockCeremony({ tool, action_class, risk, confidence, receipt_id, reason }) {
  return [
    "Mission is holding this action until you approve.",
    `Tool: ${tool}. Classified as: ${action_class} (risk ${risk}, confidence ${confidence.toFixed(2)}).`,
    reason ? `Reason: ${reason}` : "",
    "Why: Trust Graduation gates external side effects until evidence and approval lift them.",
    `Receipt id: ${receipt_id}. Approve in Mission Control or reply: "approve ${receipt_id}".`,
  ].filter(Boolean).join("\n");
}

// One stdio MCP child server. Reads newline-delimited JSON-RPC on stdout,
// writes on stdin. Tracks initialize state and pending calls by id.
export class ChildServer {
  constructor({ name, command, args = [], env = {} }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.initialized = false;
    this.dead = false;
    this.deathReason = "";
  }

  async start() {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, this.args, {
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;
      const startTimer = setTimeout(() => {
        this.dead = true;
        this.deathReason = "spawn timeout";
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        reject(new Error(`child ${this.name} spawn timeout`));
      }, CHILD_SPAWN_TIMEOUT_MS);

      proc.on("error", (error) => {
        clearTimeout(startTimer);
        this.dead = true;
        this.deathReason = `spawn error: ${error.message}`;
        this.failAllPending(this.deathReason);
        if (!this.initialized) reject(error);
      });
      proc.on("exit", (code, signal) => {
        clearTimeout(startTimer);
        this.dead = true;
        this.deathReason = `exited code=${code} signal=${signal}`;
        this.failAllPending(this.deathReason);
        if (!this.initialized) reject(new Error(this.deathReason));
      });
      proc.stderr.on("data", () => {
        // Swallow child stderr by default; we don't want to corrupt our own
        // stdio MCP framing. Future: forward to a debug log.
      });
      proc.stdout.on("data", (chunk) => this.onData(chunk));

      // Send initialize, then tools/list.
      this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "gomission-proxy", version: VERSION },
      })
        .then(() => this.request("tools/list", {}))
        .then((result) => {
          clearTimeout(startTimer);
          this.tools = Array.isArray(result?.tools) ? result.tools : [];
          this.initialized = true;
          // Per MCP spec: send notifications/initialized after init.
          this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          resolve();
        })
        .catch((error) => {
          clearTimeout(startTimer);
          this.dead = true;
          this.deathReason = `init failed: ${error.message}`;
          reject(error);
        });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl === -1) return;
      const line = this.buffer.slice(0, nl).toString("utf8").trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined || message.id === null) continue; // notification
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || `child error code ${message.error.code}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  send(message) {
    if (this.dead || !this.proc || !this.proc.stdin.writable) {
      throw new Error(`child ${this.name} is not writable: ${this.deathReason || "unknown"}`);
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error(`child ${this.name} dead: ${this.deathReason}`));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`child ${this.name} request ${method} timed out`));
      }, CHILD_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }

  failAllPending(reason) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`child ${this.name} unreachable: ${reason}`));
    }
    this.pending.clear();
  }

  stop() {
    this.failAllPending("stopped");
    try { this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

// The proxy itself. Owns N children + a stdin/stdout MCP framing.
export class Proxy {
  constructor({ workspace = resolveWorkspace(), children = [], stdin = process.stdin, stdout = process.stdout } = {}) {
    this.workspace = workspace;
    this.childList = children;
    this.children = new Map();
    this.stdin = stdin;
    this.stdout = stdout;
    this.buffer = Buffer.alloc(0);
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  respond(id, result) {
    if (id === undefined || id === null) return;
    this.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    if (id === undefined || id === null) return;
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async startChildren() {
    for (const spec of this.childList) {
      const child = new ChildServer(spec);
      this.children.set(spec.name, child);
      try {
        await child.start();
      } catch (error) {
        // A child that fails to start is recorded as dead. Its tools won't
        // appear in tools/list; any later call routed to it will block.
        child.dead = true;
        child.deathReason = child.deathReason || error.message;
      }
    }
  }

  aggregatedTools() {
    const out = [
      {
        name: "mission_status",
        description: "Return Mission proxy gate status, wrapped children, and Trust Graduation manifest.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_receipt",
        description: "Fetch a Mission receipt by id.",
        inputSchema: { type: "object", required: ["receipt_id"], properties: { receipt_id: { type: "string" } } },
      },
    ];
    for (const [name, child] of this.children) {
      if (child.dead) continue;
      for (const tool of child.tools) {
        out.push({
          ...tool,
          name: `${name}${TOOL_DELIMITER}${tool.name}`,
          description: `[wrapped by Mission gate] ${tool.description || tool.name}`,
        });
      }
    }
    return out;
  }

  parseWrappedName(qualified) {
    const idx = qualified.indexOf(TOOL_DELIMITER);
    if (idx === -1) return null;
    const childName = qualified.slice(0, idx);
    const toolName = qualified.slice(idx + TOOL_DELIMITER.length);
    if (!childName || !toolName) return null;
    if (!this.children.has(childName)) return null;
    return { childName, toolName };
  }

  textContent(text) {
    return { content: [{ type: "text", text }] };
  }

  async callBuiltin(name, args) {
    if (name === "mission_status") {
      const lines = [
        `Mission MCP proxy v${VERSION} (wrap mode)`,
        `Workspace: ${this.workspace}`,
        `Wrapped children: ${this.children.size === 0 ? "(none)" : ""}`,
      ];
      for (const [childName, child] of this.children) {
        const status = child.dead ? `DEAD (${child.deathReason})` : `${child.tools.length} tools`;
        lines.push(`  - ${childName}: ${status}`);
      }
      lines.push("Gate: Mission classifies each wrapped tool call and blocks consequential actions until you approve.");
      lines.push("No system-prompt paste step required — wrap mode intercepts every tool call automatically.");
      lines.push("Learn more: https://claude.gomission.io");
      return this.textContent(lines.join("\n"));
    }
    if (name === "get_receipt") {
      const file = path.join(receiptsDir(this.workspace), `${args.receipt_id}.json`);
      if (!fs.existsSync(file)) return this.textContent(`No receipt found for id: ${args.receipt_id}`);
      return this.textContent(fs.readFileSync(file, "utf8"));
    }
    return this.textContent(`Unknown built-in tool: ${name}`);
  }

  async callWrapped({ childName, toolName, args }) {
    const child = this.children.get(childName);
    const classification = classifyToolCall({ toolName, args });
    if (!child || child.dead) {
      // Invariant 3: unreachable child -> block. Never pass through.
      const receipt_id = newReceiptId();
      writeReceipt(this.workspace, {
        id: receipt_id,
        kind: "blocked_child_unreachable",
        child: childName,
        tool: toolName,
        action_class: classification.action_class,
        risk: classification.risk,
        confidence: classification.confidence,
        reason: child ? child.deathReason : "child not found",
        created_at: new Date().toISOString(),
        status: "blocked",
      });
      return this.textContent([
        `Mission blocked this call: child ${childName} is unreachable.`,
        `Detail: ${child ? child.deathReason : "child not found"}.`,
        `Receipt id: ${receipt_id}.`,
        "By design, Mission does not pass calls through when the wrapped server is unreachable.",
      ].join("\n"));
    }
    if (shouldBlock(classification)) {
      const receipt_id = newReceiptId();
      writeReceipt(this.workspace, {
        id: receipt_id,
        kind: "approval_request",
        child: childName,
        tool: toolName,
        action_class: classification.action_class,
        risk: classification.risk,
        confidence: classification.confidence,
        classification_reason: classification.reason,
        args_summary: summarizeArgs(args),
        created_at: new Date().toISOString(),
        status: "pending_approval",
      });
      return this.textContent(blockCeremony({
        tool: `${childName}/${toolName}`,
        action_class: classification.action_class,
        risk: classification.risk,
        confidence: classification.confidence,
        receipt_id,
        reason: classification.reason,
      }));
    }
    // Safe to forward.
    try {
      const result = await child.callTool(toolName, args);
      const receipt_id = newReceiptId();
      writeReceipt(this.workspace, {
        id: receipt_id,
        kind: "forwarded",
        child: childName,
        tool: toolName,
        action_class: classification.action_class,
        risk: classification.risk,
        confidence: classification.confidence,
        created_at: new Date().toISOString(),
        status: "forwarded",
      });
      return result;
    } catch (error) {
      // Invariant 3 again: a call error during forward -> block, not raise.
      const receipt_id = newReceiptId();
      writeReceipt(this.workspace, {
        id: receipt_id,
        kind: "blocked_child_error",
        child: childName,
        tool: toolName,
        action_class: classification.action_class,
        risk: classification.risk,
        confidence: classification.confidence,
        reason: error.message,
        created_at: new Date().toISOString(),
        status: "blocked",
      });
      return this.textContent([
        `Mission blocked this call: child ${childName} errored mid-call.`,
        `Detail: ${error.message}.`,
        `Receipt id: ${receipt_id}.`,
      ].join("\n"));
    }
  }

  async callTool(name, args = {}) {
    if (name === "mission_status" || name === "get_receipt") {
      return this.callBuiltin(name, args);
    }
    const parsed = this.parseWrappedName(name);
    if (!parsed) return this.textContent(`Unknown tool: ${name}`);
    return this.callWrapped({ ...parsed, args });
  }

  handle(message) {
    const { id, method, params = {} } = message;
    try {
      if (method === "initialize") {
        const negotiation = negotiateProtocolVersion(params?.protocolVersion);
        const version = negotiation.ok ? negotiation.version : PROTOCOL_VERSION;
        this.sessionProtocolVersion = version;
        this.respond(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "gomission-proxy", version: VERSION },
        });
        return;
      }
      if (!this.sessionProtocolVersion && method !== "notifications/initialized") {
        this.respondError(id, -32002, "initialize_required_before_other_methods");
        return;
      }
      if (method === "tools/list") {
        this.respond(id, { tools: this.aggregatedTools() });
        return;
      }
      if (method === "tools/call") {
        Promise.resolve(this.callTool(params.name, params.arguments || {}))
          .then((result) => this.respond(id, result))
          .catch((error) => this.respondError(id, -32000, error.message || String(error)));
        return;
      }
      if (method === "notifications/initialized") return;
      this.respondError(id, -32601, `Method not found: ${method}`);
    } catch (error) {
      this.respondError(id, -32000, error.message || String(error));
    }
  }

  async run() {
    await this.startChildren();
    return new Promise(() => {
      this.stdin.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (true) {
          const nl = this.buffer.indexOf(0x0a);
          if (nl === -1) return;
          const line = this.buffer.slice(0, nl).toString("utf8").trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          try {
            this.handle(JSON.parse(line));
          } catch (error) {
            this.respondError(null, -32700, error.message || "Parse error");
          }
        }
      });
    });
  }

  stop() {
    for (const [, child] of this.children) child.stop();
  }
}

function summarizeArgs(args = {}) {
  try {
    const json = JSON.stringify(args);
    return json.length > 500 ? `${json.slice(0, 500)}...` : json;
  } catch {
    return "(unserializable)";
  }
}

export async function startProxy({ workspace = "" } = {}) {
  const resolved = resolveWorkspace(workspace);
  const { wrappable } = discoverFromClaudeConfig();
  const proxy = new Proxy({ workspace: resolved, children: wrappable });
  return proxy.run();
}
