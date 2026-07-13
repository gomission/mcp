// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Use a distinct key from Mission's own CLI (`mission mcp install-claude`,
// which writes mcpServers.mission). This lets a user keep both:
// - mcpServers.mission   -> full local Mission install (if present)
// - mcpServers.gomission -> @gomission/mcp gate (remote or local stub)
export const SERVER_KEY = "gomission";

export function claudeConfigPath(platform = process.platform, home = os.homedir()) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

// claude.gomission.io is the Claude-specific endpoint and serves the Trust
// Graduation primitives (mission_status, request_approval, log_action,
// get_receipt). gomission.io/mcp/ remains the OpenAI app endpoint and stays
// strictly read-only.
export const REMOTE_MCP_URL = "https://claude.gomission.io/mcp/";

export function buildMissionEntry({ mode = "remote", workspace = "", remoteUrl = REMOTE_MCP_URL, token = "" } = {}) {
  if (mode === "remote") {
    // Claude Desktop's claude_desktop_config.json only supports stdio MCP
    // entries — it does not honor a `{url}` field directly. Remote MCP from
    // claude.ai is added through the Custom Connectors UI. To install a
    // working remote bridge from the CLI, we use `mcp-remote`, which is a
    // stdio↔HTTP+SSE bridge and handles the OAuth dance against the server.
    const entry = {
      command: "npx",
      args: ["-y", "mcp-remote", remoteUrl],
    };
    if (token) {
      entry.args = ["-y", "mcp-remote", remoteUrl, "--header", `Authorization: Bearer ${token}`];
    }
    return entry;
  }
  if (mode === "wrap") {
    // Wrap mode: the proxy reads Claude Desktop's mcpServers map, spawns each
    // qualifying child as a stdio subprocess, multiplexes their tools, and
    // gates each tools/call through Trust Graduation classification.
    const entry = {
      command: "npx",
      args: ["-y", "@gomission/mcp", "serve", "--wrap"],
    };
    if (workspace) entry.env = { MISSION_WORKSPACE: workspace };
    return entry;
  }
  // Local stdio mode: run our packaged serve via npx so users don't need a
  // separate Mission install. If MISSION_WORKSPACE is set, the server bridges
  // receipts to that workspace.
  const entry = {
    command: "npx",
    args: ["-y", "@gomission/mcp", "serve"],
  };
  if (workspace) entry.env = { MISSION_WORKSPACE: workspace };
  return entry;
}

export function mergeConfig(existing, missionEntry) {
  const next = existing && typeof existing === "object" ? { ...existing } : {};
  const servers = next.mcpServers && typeof next.mcpServers === "object" ? { ...next.mcpServers } : {};
  const before = JSON.stringify(servers[SERVER_KEY] || null);
  servers[SERVER_KEY] = missionEntry;
  next.mcpServers = servers;
  const after = JSON.stringify(servers[SERVER_KEY]);
  return { config: next, changed: before !== after, previous: before === "null" ? null : JSON.parse(before) };
}

export function readExistingConfig(configFile) {
  if (!fs.existsSync(configFile)) return null;
  const raw = fs.readFileSync(configFile, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const err = new Error(`Existing Claude Desktop config at ${configFile} is not valid JSON: ${error.message}`);
    err.code = "INVALID_CONFIG";
    throw err;
  }
}

export function writeConfigAtomic(configFile, config) {
  const dir = path.dirname(configFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${configFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, configFile);
}

// Recommend an install mode based on the user's existing Claude Desktop config.
// Decision tree:
//   1. Wrappable MCP children already configured → "wrap" (hard-wired gating,
//      no system-prompt paste step required).
//   2. Otherwise → "local" (approval ceremony for Mission's own tools; still
//      needs the user to instruct Claude to use Mission for the gate to fire).
// The remote read-only path is never auto-selected. Users who explicitly want
// the lowest-friction visibility-only install pass --remote.
export async function recommendMode({ existingConfig = null, optOut = null } = {}) {
  // Lazy-import to avoid a circular load between install.mjs and proxy-discover.mjs
  // (proxy-discover imports SERVER_KEY/claudeConfigPath/readExistingConfig from here).
  const { selectWrappable, parseOptOut } = await import("./proxy-discover.mjs");
  const resolvedOptOut = optOut || parseOptOut("");
  const servers = (existingConfig && typeof existingConfig === "object" && existingConfig.mcpServers) || {};
  const wrappable = selectWrappable(servers, resolvedOptOut);
  if (wrappable.length > 0) {
    return {
      mode: "wrap",
      reason: `${wrappable.length} wrappable MCP server${wrappable.length === 1 ? "" : "s"} detected (${wrappable.map((w) => w.name).join(", ")}). Wrap mode gates each tool call automatically; no system-prompt paste step.`,
      wrappableCount: wrappable.length,
      wrappableNames: wrappable.map((w) => w.name),
    };
  }
  return {
    mode: "local",
    reason: "No other MCP servers detected. Local mode runs the Trust Graduation approval ceremony for Mission's own tools.",
    wrappableCount: 0,
    wrappableNames: [],
  };
}

export async function installClaudeDesktop({
  platform = process.platform,
  home = os.homedir(),
  configFile = claudeConfigPath(platform, home),
  mode = "remote",
  remoteUrl = REMOTE_MCP_URL,
  token = "",
  workspace = "",
  dryRun = false,
  force = false,
} = {}) {
  const dir = path.dirname(configFile);
  if (!fs.existsSync(dir) && !force) {
    const err = new Error(`Claude Desktop config directory not found at ${dir}`);
    err.code = "CLAUDE_NOT_FOUND";
    throw err;
  }
  const existing = readExistingConfig(configFile);
  const missionEntry = buildMissionEntry({ mode, workspace, remoteUrl, token });
  const { config } = mergeConfig(existing || {}, missionEntry);
  if (!dryRun) {
    writeConfigAtomic(configFile, config);
  }
  return { configFile, config, mode };
}
