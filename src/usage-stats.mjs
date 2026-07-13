// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

// Minimal usage stats for paste-step-missed detection.
//
// The local stdio install (`install-claude --local`) requires a one-time
// system-prompt instruction so Claude knows to call `request_approval` before
// consequential actions. Forgetting the paste step is silent: Mission is
// installed, the tool list is exposed, but the gate never fires.
//
// This module tracks two counters in `~/.gomission-mcp/usage.json`:
//   * sessions_started      — incremented on each MCP `initialize` request
//   * request_approval_calls — incremented on each `request_approval` tool call
//
// `verify` reads this file and warns when sessions accumulated past the
// threshold without a single approval request — strong signal that the user
// installed --local but did not paste the gating instruction.
//
// All functions are no-throw. Stats writes happen in serve.mjs on the request
// hot path, so they MUST NOT block or surface errors back to the caller.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATS_DIR = path.join(os.homedir(), ".gomission-mcp");
const STATS_FILE = path.join(STATS_DIR, "usage.json");

// Threshold beyond which a local-mode install with zero approval calls is
// considered evidence of a missed paste step. Picked low enough to trigger
// inside a single day of light Claude Desktop use, high enough that a one-off
// installer who hasn't tested yet doesn't get a false positive.
export const PASTE_STEP_SESSION_THRESHOLD = 3;

export function usageStatsPath() {
  return STATS_FILE;
}

function emptyStats() {
  return {
    sessions_started: 0,
    request_approval_calls: 0,
    first_session_at: null,
    last_session_at: null,
    last_approval_at: null,
  };
}

export function readUsageStats(file = STATS_FILE) {
  try {
    if (!fs.existsSync(file)) return emptyStats();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...emptyStats(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return emptyStats();
  }
}

function writeStats(stats, file = STATS_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function recordSessionStart({ file = STATS_FILE, now = new Date() } = {}) {
  try {
    const stats = readUsageStats(file);
    stats.sessions_started = Number(stats.sessions_started || 0) + 1;
    stats.last_session_at = now.toISOString();
    if (!stats.first_session_at) stats.first_session_at = now.toISOString();
    writeStats(stats, file);
    return stats;
  } catch {
    return null;
  }
}

export function recordApprovalCall({ file = STATS_FILE, now = new Date() } = {}) {
  try {
    const stats = readUsageStats(file);
    stats.request_approval_calls = Number(stats.request_approval_calls || 0) + 1;
    stats.last_approval_at = now.toISOString();
    writeStats(stats, file);
    return stats;
  } catch {
    return null;
  }
}

// Returns a structured warning if the user is likely missing the paste step.
// Pass the install mode classification (from verify.classifyEntry) so the
// check is skipped for modes that don't need the paste step (wrap / remote).
export function pasteStepWarning({ mode = "", stats = null, file = STATS_FILE } = {}) {
  if (mode !== "local-stub") return null;
  const resolved = stats || readUsageStats(file);
  const sessions = Number(resolved.sessions_started || 0);
  const approvals = Number(resolved.request_approval_calls || 0);
  if (sessions < PASTE_STEP_SESSION_THRESHOLD) return null;
  if (approvals > 0) return null;
  return {
    code: "paste_step_likely_missed",
    sessions_started: sessions,
    request_approval_calls: approvals,
    message: `Mission has run in ${sessions} sessions but request_approval was never called. The local-mode gating instruction was probably not pasted into Claude Desktop's Settings → Profile → Personal preferences. Re-run install-claude and follow the STEP 3 instructions, or switch to --wrap for automatic gating.`,
  };
}
