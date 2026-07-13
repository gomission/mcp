// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

// Discovery for the Mission proxy: read Claude Desktop's mcpServers map,
// decide which entries to wrap, honor MISSION_DONT_WRAP opt-out.
//
// Wrapping heuristic: any server whose key OR command/args looks like it
// might expose consequential actions (send/post/email/calendar/payment/etc).
// We wrap broadly and rely on per-call classification to gate; over-wrapping
// is cheap, under-wrapping leaks an external call past the gate.

import fs from "node:fs";
import { claudeConfigPath, readExistingConfig, SERVER_KEY } from "./install.mjs";

// Server keys that are ALWAYS skipped: our own gomission entry (don't wrap
// the gate with the gate) and any server the user explicitly opts out of via
// MISSION_DONT_WRAP="key1,key2".
const ALWAYS_SKIP = new Set([SERVER_KEY, "mission", "gomission-proxy"]);

// Heuristic: if any token in the server key, command, or args strings matches
// one of these verbs, the server is a wrap candidate. Conservative — we'd
// rather wrap a read-only server than miss a write-capable one.
const WRAP_VERB_RX = /\b(gmail|outlook|mail|email|slack|discord|telegram|twitter|x|linkedin|facebook|instagram|notion|airtable|sheets|drive|calendar|stripe|plaid|payment|wallet|hubspot|salesforce|zendesk|jira|github|gitlab|asana|trello|monday|figma|miro|zoom|meet|webex|send|post|publish|create|write|update|delete)\b/i;

export function parseOptOut(envValue = process.env.MISSION_DONT_WRAP || "") {
  return new Set(
    String(envValue)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function entrySignals(name, entry) {
  const parts = [name];
  if (entry && typeof entry === "object") {
    if (typeof entry.command === "string") parts.push(entry.command);
    if (Array.isArray(entry.args)) parts.push(entry.args.filter((a) => typeof a === "string").join(" "));
  }
  return parts.join(" ");
}

export function selectWrappable(mcpServers = {}, optOut = parseOptOut()) {
  if (!mcpServers || typeof mcpServers !== "object") return [];
  const wrappable = [];
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (ALWAYS_SKIP.has(name)) continue;
    if (optOut.has(name.toLowerCase())) continue;
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command !== "string" || !entry.command) continue;
    const signal = entrySignals(name, entry);
    if (!WRAP_VERB_RX.test(signal)) continue;
    wrappable.push({
      name,
      command: entry.command,
      args: Array.isArray(entry.args) ? [...entry.args] : [],
      env: entry.env && typeof entry.env === "object" ? { ...entry.env } : {},
    });
  }
  return wrappable;
}

export function discoverFromClaudeConfig({
  configFile = claudeConfigPath(),
  optOut = parseOptOut(),
} = {}) {
  if (!fs.existsSync(configFile)) {
    return { configFile, wrappable: [], reason: "claude config not found" };
  }
  let config;
  try {
    config = readExistingConfig(configFile) || {};
  } catch (error) {
    return { configFile, wrappable: [], reason: `config read error: ${error.message}` };
  }
  const wrappable = selectWrappable(config.mcpServers || {}, optOut);
  return { configFile, wrappable };
}
