// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

// Tests that mission_status surfaces the right gating posture so a curious
// Claude user can ask "Mission, what is going on?" and get an honest answer:
// which mode is running, whether the paste step worked, whether they have
// other MCP servers they could be auto-gating via --wrap.
//
// The real serve.mjs reads ~/.gomission-mcp/usage.json via readUsageStats;
// we cannot easily inject a different path without refactoring callTool's
// signature. Instead these tests assert via the usage-stats helpers + the
// wrap-suggestion discovery helper which DO accept injectable paths.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PASTE_STEP_SESSION_THRESHOLD, pasteStepWarning, recordApprovalCall, recordSessionStart } from "../src/usage-stats.mjs";
import { discoverFromClaudeConfig, parseOptOut } from "../src/proxy-discover.mjs";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tmpStatsFile() {
  return path.join(tmpDir("mission-status-stats-"), "usage.json");
}

test("local-stub posture: paste step working when approvals > 0", () => {
  const file = tmpStatsFile();
  recordSessionStart({ file });
  recordSessionStart({ file });
  recordApprovalCall({ file });
  const warning = pasteStepWarning({ mode: "local-stub", file });
  assert.equal(warning, null, "approvals > 0 should clear the warning");
});

test("local-stub posture: paste step missing fires at threshold", () => {
  const file = tmpStatsFile();
  for (let i = 0; i < PASTE_STEP_SESSION_THRESHOLD; i += 1) recordSessionStart({ file });
  const warning = pasteStepWarning({ mode: "local-stub", file });
  assert.ok(warning, "expected paste-step warning");
  assert.equal(warning.code, "paste_step_likely_missed");
});

test("wrap-suggestion: discoverFromClaudeConfig surfaces unwrapped children", () => {
  const dir = tmpDir("mission-status-config-");
  const configFile = path.join(dir, "claude_desktop_config.json");
  fs.writeFileSync(configFile, JSON.stringify({
    mcpServers: {
      gmail: { command: "npx", args: ["@x/gmail"] },
      slack: { command: "npx", args: ["@x/slack"] },
    },
  }), "utf8");
  const { wrappable } = discoverFromClaudeConfig({ configFile, optOut: parseOptOut("") });
  assert.equal(wrappable.length, 2);
  assert.deepEqual(wrappable.map((w) => w.name).sort(), ["gmail", "slack"]);
});

test("wrap-suggestion: no unwrapped children when config is empty", () => {
  const dir = tmpDir("mission-status-empty-");
  const configFile = path.join(dir, "claude_desktop_config.json");
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: {} }), "utf8");
  const { wrappable } = discoverFromClaudeConfig({ configFile, optOut: parseOptOut("") });
  assert.equal(wrappable.length, 0);
});

test("wrap-suggestion: opt-out removes children from the unwrapped list", () => {
  const dir = tmpDir("mission-status-optout-");
  const configFile = path.join(dir, "claude_desktop_config.json");
  fs.writeFileSync(configFile, JSON.stringify({
    mcpServers: {
      gmail: { command: "npx", args: ["@x/gmail"] },
      slack: { command: "npx", args: ["@x/slack"] },
    },
  }), "utf8");
  const { wrappable } = discoverFromClaudeConfig({ configFile, optOut: parseOptOut("gmail") });
  assert.equal(wrappable.length, 1);
  assert.equal(wrappable[0].name, "slack");
});

test("wrap-suggestion: missing claude config does not throw", () => {
  const { wrappable } = discoverFromClaudeConfig({ configFile: "/this/path/should/not/exist/claude.json" });
  assert.deepEqual(wrappable, []);
});
