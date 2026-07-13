// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

// Minimal Mission MCP stdio server. Zero dependencies. Implements MCP
// 2025-11-25 with backwards-compatible negotiation to 2024-11-05 for existing
// pilots, matching the convention used by Mission's main MCP server in
// src/mcp-server.mjs.
//
// v0.1.0 ships the Trust Graduation primitives as a permission-layer-only
// surface: any consequential action class returns an approval-required
// ceremony with a receipt id. When a Mission workspace is present (via
// MISSION_WORKSPACE env or .mission-workspace.json in cwd), receipts are
// bridged to that workspace's receipts/ directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PASTE_STEP_SESSION_THRESHOLD, readUsageStats, recordApprovalCall, recordSessionStart } from "./usage-stats.mjs";
import { discoverFromClaudeConfig, parseOptOut } from "./proxy-discover.mjs";
import { negotiateProtocolVersion, PREFERRED_PROTOCOL_VERSION } from "./protocol.mjs";

const VERSION = "0.1.0";
// Preferred protocol version. Actual per-session version is negotiated in the
// initialize handler and stored in `sessionProtocolVersion` for logging.
const PROTOCOL_VERSION = PREFERRED_PROTOCOL_VERSION;
let sessionProtocolVersion = "";
const ACTION_CLASSES = [
  "send_email",
  "post_public",
  "send_dm",
  "schedule_meeting",
  "spend_money",
  "publish_artifact",
  "modify_external_record",
  "change_trust_policy",
];

// Bridge to a locally-running Mission web server. `mission web 8814` is the
// canonical command; users can override the URL with MISSION_LOCAL_URL.
const MISSION_LOCAL_URL =
  process.env.MISSION_LOCAL_URL
  || `http://127.0.0.1:${process.env.MISSION_LOCAL_PORT || "8814"}`;
const MISSION_PROBE_TIMEOUT_MS = 2500;
const MISSION_ASK_TIMEOUT_MS = 30000;

async function probeMissionLocal() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MISSION_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${MISSION_LOCAL_URL}/api/state`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const state = await res.json().catch(() => ({}));
    return { ok: true, workspace: state.workspace || null };
  } catch (error) {
    return { ok: false, reason: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function askMissionBrain(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MISSION_ASK_TIMEOUT_MS);
  try {
    const res = await fetch(`${MISSION_LOCAL_URL}/api/command-capture`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ command: query }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, body: text.slice(0, 500) };
    }
    return await res.json();
  } catch (error) {
    return { ok: false, reason: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

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

function approvalCeremony({ action_class, summary, receipt_id }) {
  return [
    "Mission is holding this action until you approve.",
    `Action class: ${action_class}. Summary: ${summary || "no summary provided"}.`,
    "Why: Trust Graduation gates this class until evidence and approval lift it.",
    `Receipt id: ${receipt_id}. Approve in Mission Control or reply: "approve ${receipt_id}".`,
  ].join("\n");
}

const TOOLS = [
  {
    name: "mission_status",
    description:
      "Return Mission gate status, version, and the current Trust Graduation action classes. Call this first in any session to introduce the permission layer.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "request_approval",
    description:
      "Mission gates any consequential action. Call this BEFORE executing actions in classes like send_email, post_public, send_dm, schedule_meeting, spend_money, publish_artifact, modify_external_record, change_trust_policy. Mission returns an approval-required ceremony and writes a receipt. Do not proceed without approval.",
    inputSchema: {
      type: "object",
      required: ["action_class", "summary"],
      properties: {
        action_class: { type: "string", description: `One of: ${ACTION_CLASSES.join(", ")}` },
        summary: { type: "string", description: "One-line plain-English summary of the action." },
        evidence: { type: "string", description: "Optional evidence supporting the action." },
      },
    },
  },
  {
    name: "log_action",
    description:
      "Log a safe internal action with Mission. Returns a receipt id. Use for non-external actions that still benefit from a permanent receipt.",
    inputSchema: {
      type: "object",
      required: ["action_class", "summary"],
      properties: {
        action_class: { type: "string" },
        summary: { type: "string" },
        evidence: { type: "string" },
      },
    },
  },
  {
    name: "get_receipt",
    description: "Fetch a Mission receipt by id.",
    inputSchema: {
      type: "object",
      required: ["receipt_id"],
      properties: { receipt_id: { type: "string" } },
    },
  },
  {
    name: "mission_ask",
    description:
      "Talk to Mission's hero chatbox brain. Mission is the user's operating intelligence: it knows the user's open loops, draft queue, voice profile, weekly proof state, learning evidence, and active focus. Use this when the user asks anything about their work, their week, what to approve, what to prepare, who to follow up with, or what Mission thinks. Requires a local Mission running (mission web 8814). Returns the brain's reply array and any prepared actions. Always use this BEFORE drafting a reply or proposing work — Mission already knows what the user is doing.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "A natural-language question or instruction for Mission. Examples: 'what should I approve today?', 'who am I dropping?', 'prepare a reply to Sandro', 'show me my weekly proof', 'what did I just learn?'" },
      },
    },
  },
];

function textContent(text) {
  return { content: [{ type: "text", text }] };
}

async function callTool(workspace, name, args = {}) {
  if (name === "mission_status") {
    const probe = await probeMissionLocal();
    const localLine = probe.ok
      ? `Local Mission detected at ${MISSION_LOCAL_URL} (workspace: ${probe.workspace || "unknown"}). mission_ask is wired to the hero chatbox brain.`
      : `Local Mission not detected at ${MISSION_LOCAL_URL}. Run 'mission web 8814' to enable mission_ask.`;

    // Paste-step posture: have any approval requests fired in this install's
    // history? If sessions accumulated past the threshold with zero approvals,
    // the user almost certainly skipped the system-prompt instruction.
    const stats = readUsageStats();
    const sessions = Number(stats.sessions_started || 0);
    const approvals = Number(stats.request_approval_calls || 0);
    let pasteLine = "";
    if (approvals > 0) {
      pasteLine = `Paste step working — ${approvals} approval request${approvals === 1 ? "" : "s"} fired across ${sessions} session${sessions === 1 ? "" : "s"}.`;
    } else if (sessions >= PASTE_STEP_SESSION_THRESHOLD) {
      pasteLine = `WARNING: paste step may be missing — ${sessions} sessions, 0 approvals. Paste the gating instruction into Claude Desktop's Settings → Profile → Personal preferences, or re-install with --wrap to skip the paste step.`;
    } else {
      pasteLine = `Sessions: ${sessions} (paste-step warning fires at ${PASTE_STEP_SESSION_THRESHOLD}+ sessions with no approvals).`;
    }

    // Wrap-suggestion posture: detect other MCP servers in Claude Desktop's
    // config that this user could be auto-gating via --wrap mode. If any
    // exist while we're running in local-stub mode, surface the suggestion.
    let wrapLine = "";
    try {
      const { wrappable } = discoverFromClaudeConfig({ optOut: parseOptOut() });
      if (wrappable.length > 0) {
        const names = wrappable.map((w) => w.name).join(", ");
        wrapLine = `${wrappable.length} other MCP server${wrappable.length === 1 ? "" : "s"} (${names}) could be auto-gated. Re-install with: npx -y @gomission/mcp install-claude --wrap`;
      }
    } catch {
      wrapLine = "";
    }

    const lines = [
      `Mission MCP gate v${VERSION} (local-stub mode)`,
      `Workspace: ${workspace}`,
      `Action classes gated by Trust Graduation: ${ACTION_CLASSES.join(", ")}`,
      localLine,
      pasteLine,
    ];
    if (wrapLine) lines.push(wrapLine);
    lines.push(
      "Wedge: Claude can do more for you once Mission decides what it's allowed to do.",
      "Learn more: https://claude.gomission.io",
    );
    return textContent(lines.join("\n"));
  }
  if (name === "mission_ask") {
    const query = String(args.query || "").trim();
    if (!query) return textContent("mission_ask requires a non-empty query.");
    const probe = await probeMissionLocal();
    if (!probe.ok) {
      return textContent(
        [
          "Mission's hero chatbox brain is not reachable locally.",
          `Tried: ${MISSION_LOCAL_URL}/api/state (${probe.reason || `HTTP ${probe.status}`}).`,
          "Run 'mission web 8814' in a terminal, or set MISSION_LOCAL_URL to your Mission web server URL.",
          "If you do not have Mission installed, visit https://claude.gomission.io and follow the local-install path.",
        ].join("\n"),
      );
    }
    const result = await askMissionBrain(query);
    if (!result || result.ok === false) {
      return textContent(
        [
          "Mission brain returned an error.",
          result?.reason ? `Reason: ${result.reason}` : "",
          result?.status ? `HTTP ${result.status}` : "",
          result?.body ? `Body: ${result.body}` : "",
        ].filter(Boolean).join("\n"),
      );
    }
    const reply = Array.isArray(result.reply) ? result.reply.join("\n") : (result.reply || "");
    const actions = Array.isArray(result.actions) ? result.actions : [];
    const decision = result.decision || "answered";
    const lines = [
      `Mission brain (${decision}):`,
      reply || "(no reply text)",
    ];
    if (actions.length) {
      lines.push("", "Prepared actions:");
      for (const a of actions) {
        lines.push(`  - [${a.kind || "action"}] ${a.label || a.id || ""}`.trim());
      }
    }
    if (result.proposed_action) {
      lines.push("", `Proposed action: ${result.proposed_action.decision || ""} — ${result.proposed_action.request || ""}`);
    }
    if (result.follow_up_actions?.length) {
      lines.push("", "Follow-ups available: " + result.follow_up_actions.map((f) => f.label || f.kind).join(", "));
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: result,
    };
  }
  if (name === "request_approval") {
    recordApprovalCall();
    const id = newReceiptId();
    writeReceipt(workspace, {
      id,
      kind: "approval_request",
      action_class: args.action_class,
      summary: args.summary,
      evidence: args.evidence || "",
      created_at: new Date().toISOString(),
      status: "pending_approval",
    });
    return textContent(approvalCeremony({
      action_class: args.action_class,
      summary: args.summary,
      receipt_id: id,
    }));
  }
  if (name === "log_action") {
    const id = newReceiptId();
    writeReceipt(workspace, {
      id,
      kind: "internal_action",
      action_class: args.action_class,
      summary: args.summary,
      evidence: args.evidence || "",
      created_at: new Date().toISOString(),
      status: "logged",
    });
    return textContent(`Logged internal action. Receipt id: ${id}`);
  }
  if (name === "get_receipt") {
    const file = path.join(receiptsDir(workspace), `${args.receipt_id}.json`);
    if (!fs.existsSync(file)) return textContent(`No receipt found for id: ${args.receipt_id}`);
    return textContent(fs.readFileSync(file, "utf8"));
  }
  return textContent(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(workspace, message) {
  const { id, method, params = {} } = message;
  try {
    if (method === "initialize") {
      recordSessionStart();
      const negotiation = negotiateProtocolVersion(params?.protocolVersion);
      // Spec: even when the client's version is unsupported we still respond
      // with our preferred one so the client can decide to disconnect. Never
      // silently claim to support a version we do not.
      const version = negotiation.ok ? negotiation.version : PROTOCOL_VERSION;
      sessionProtocolVersion = version;
      respond(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "gomission", version: VERSION },
      });
      return;
    }
    if (!sessionProtocolVersion && method !== "notifications/initialized") {
      // Requests before initialize fail closed. The client MUST call initialize
      // first per lifecycle spec.
      respondError(id, -32002, "initialize_required_before_other_methods");
      return;
    }
    if (method === "tools/list") {
      respond(id, { tools: TOOLS });
      return;
    }
    if (method === "tools/call") {
      Promise.resolve(callTool(workspace, params.name, params.arguments || {}))
        .then((result) => respond(id, result))
        .catch((error) => respondError(id, -32000, error.message || String(error)));
      return;
    }
    if (method === "notifications/initialized") return;
    respondError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    respondError(id, -32000, error.message || String(error));
  }
}

export async function startServer({ workspace = "" } = {}) {
  const resolved = resolveWorkspace(workspace);
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const nl = buffer.indexOf(0x0a);
      if (nl === -1) return;
      const line = buffer.slice(0, nl).toString("utf8").trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        handle(resolved, JSON.parse(line));
      } catch (error) {
        respondError(null, -32700, error.message || "Parse error");
      }
    }
  });
  return new Promise(() => {});
}
