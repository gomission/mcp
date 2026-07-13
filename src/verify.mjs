// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

// `gomission-mcp verify` — Self-check for an existing install.
// Reads Claude Desktop's config, classifies the gomission entry's mode, and
// optionally probes the remote MCP endpoint with a real initialize +
// tools/list round-trip. Designed so users can answer "did it install?"
// without filing a support thread.

import fs from "node:fs";
import { claudeConfigPath, readExistingConfig, SERVER_KEY, REMOTE_MCP_URL } from "./install.mjs";
import { pasteStepWarning, readUsageStats } from "./usage-stats.mjs";
import { PREFERRED_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_HEADER, isSupportedProtocolVersion } from "./protocol.mjs";

const MCP_PROTOCOL_VERSION = PREFERRED_PROTOCOL_VERSION;
const PROBE_TIMEOUT_MS = 8000;

function classifyEntry(entry) {
  if (!entry || typeof entry !== "object") return { mode: "missing" };
  if (entry.url) return { mode: "remote-url", url: entry.url };
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (entry.command === "npx" && args.includes("mcp-remote")) {
    const urlArg = args.find((a) => /^https?:\/\//.test(a));
    return { mode: "remote-bridge", url: urlArg || REMOTE_MCP_URL };
  }
  if (entry.command === "npx" && args.includes("@gomission/mcp") && args.includes("serve")) {
    if (args.includes("--wrap")) {
      return { mode: "local-proxy", workspace: entry.env?.MISSION_WORKSPACE || "" };
    }
    return { mode: "local-stub", workspace: entry.env?.MISSION_WORKSPACE || "" };
  }
  if (entry.command && Array.isArray(entry.args)) {
    return { mode: "custom", command: entry.command, args };
  }
  return { mode: "unknown" };
}

async function probeRemote(url) {
  if (typeof fetch !== "function") {
    return { ok: false, reason: "global fetch is not available (Node 20+ required)" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const initResp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "gomission-mcp-verify", version: "0" } },
      }),
    });
    if (!initResp.ok) return { ok: false, reason: `initialize returned HTTP ${initResp.status}` };
    const initJson = await initResp.json();
    const serverInfo = initJson?.result?.serverInfo;
    const negotiatedVersion = initJson?.result?.protocolVersion || "";
    if (!isSupportedProtocolVersion(negotiatedVersion)) {
      return { ok: false, reason: `server negotiated an unsupported protocol version: ${negotiatedVersion || "<none>"}` };
    }
    // Post-initialize requests MUST carry MCP-Protocol-Version per the 2025-11-25
    // basic transport spec. We use the negotiated version, not the preferred one.
    const toolsResp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MCP_PROTOCOL_VERSION_HEADER]: negotiatedVersion,
      },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    if (!toolsResp.ok) return { ok: false, reason: `tools/list returned HTTP ${toolsResp.status}` };
    const toolsJson = await toolsResp.json();
    const tools = toolsJson?.result?.tools || [];
    const names = tools.map((t) => t.name);
    return {
      ok: true,
      serverInfo,
      protocol_version: negotiatedVersion,
      tool_count: tools.length,
      has_ceremony_primitives: ["mission_status", "request_approval", "log_action", "get_receipt"].every((n) => names.includes(n)),
    };
  } catch (error) {
    return { ok: false, reason: error.name === "AbortError" ? `timed out after ${PROBE_TIMEOUT_MS}ms` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyInstall({ json = false, probe = true, configFile = claudeConfigPath() } = {}) {
  const present = fs.existsSync(configFile);
  const config = present ? readExistingConfig(configFile) : null;
  const entry = config?.mcpServers?.[SERVER_KEY] || null;
  const classification = classifyEntry(entry);

  const report = {
    config_file: configFile,
    config_file_present: present,
    gomission_entry_present: Boolean(entry),
    mode: classification.mode,
    entry: entry || null,
    classification,
  };

  if (probe && (classification.mode === "remote-url" || classification.mode === "remote-bridge")) {
    report.endpoint_probe = await probeRemote(classification.url);
  }
  if (classification.mode === "local-proxy") {
    const { discoverFromClaudeConfig, parseOptOut } = await import("./proxy-discover.mjs");
    const optOutRaw = entry?.env?.MISSION_DONT_WRAP || "";
    const { wrappable } = discoverFromClaudeConfig({ configFile, optOut: parseOptOut(optOutRaw) });
    report.wrap_inventory = {
      opt_out: optOutRaw || "(none)",
      wrappable_children: wrappable.map((w) => ({ name: w.name, command: w.command })),
    };
  }

  // Paste-step detection: in local-stub mode, warn if Mission has run in N+
  // sessions without a single request_approval call. Strong signal that the
  // user installed --local but skipped the system-prompt paste step.
  const stats = readUsageStats();
  report.usage_stats = stats;
  const warning = pasteStepWarning({ mode: classification.mode, stats });
  if (warning) report.warning = warning;

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return reportExitCode(report);
  }

  process.stdout.write(`Claude Desktop config: ${configFile}\n`);
  if (!present) {
    process.stdout.write("Status: config file does not exist. Run: npx -y @gomission/mcp install-claude\n");
    return 2;
  }
  if (!entry) {
    process.stdout.write("Status: no `gomission` entry. Run: npx -y @gomission/mcp install-claude\n");
    return 2;
  }
  process.stdout.write(`Mode:   ${describeMode(classification.mode)}\n`);
  if (classification.url) process.stdout.write(`URL:    ${classification.url}\n`);
  if (classification.workspace) process.stdout.write(`Workspace: ${classification.workspace}\n`);
  if (report.endpoint_probe) {
    const p = report.endpoint_probe;
    if (p.ok) {
      process.stdout.write(`Probe:  ok — server ${p.serverInfo?.name || "?"} v${p.serverInfo?.version || "?"}, ${p.tool_count} tools${p.has_ceremony_primitives ? " (ceremony primitives present)" : " (ceremony primitives MISSING)"}\n`);
    } else {
      process.stdout.write(`Probe:  failed — ${p.reason}\n`);
    }
  }
  if (report.wrap_inventory) {
    const inv = report.wrap_inventory;
    process.stdout.write(`Opt-out: ${inv.opt_out}\n`);
    if (inv.wrappable_children.length === 0) {
      process.stdout.write("Wraps:  (no wrappable children — proxy will only expose mission_status and get_receipt)\n");
    } else {
      process.stdout.write(`Wraps:  ${inv.wrappable_children.length} child server(s):\n`);
      for (const child of inv.wrappable_children) {
        process.stdout.write(`  - ${child.name} (${child.command})\n`);
      }
    }
  }
  if (report.warning) {
    process.stdout.write("\n");
    process.stdout.write(`WARNING: ${report.warning.message}\n`);
  }
  process.stdout.write("\nRestart Claude Desktop to load any new config. Ask Claude: `mission status`.\n");
  process.stdout.write("Learn more: https://claude.gomission.io\n");
  return reportExitCode(report);
}

function describeMode(mode) {
  switch (mode) {
    case "remote-bridge": return "remote (via mcp-remote stdio↔HTTP bridge)";
    case "remote-url": return "remote (direct URL — Claude Desktop config does not honor this; reinstall with `install-claude --remote` to fix)";
    case "local-stub": return "local (packaged stdio server)";
    case "local-proxy": return "local proxy (wraps other mcpServers and gates each tool call)";
    case "custom": return "custom (entry was written by something other than this CLI)";
    case "missing": return "missing";
    case "unknown": return "unknown";
    default: return mode;
  }
}

function reportExitCode(report) {
  if (!report.config_file_present) return 2;
  if (!report.gomission_entry_present) return 2;
  if (report.mode === "remote-url") return 3;
  if (report.endpoint_probe && !report.endpoint_probe.ok) return 4;
  return 0;
}
