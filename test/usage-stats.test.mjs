// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PASTE_STEP_SESSION_THRESHOLD,
  pasteStepWarning,
  readUsageStats,
  recordApprovalCall,
  recordSessionStart,
} from "../src/usage-stats.mjs";

function tmpStatsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-usage-stats-"));
  return path.join(dir, "usage.json");
}

test("readUsageStats returns empty stats when file does not exist", () => {
  const file = tmpStatsFile();
  const stats = readUsageStats(file);
  assert.equal(stats.sessions_started, 0);
  assert.equal(stats.request_approval_calls, 0);
  assert.equal(stats.first_session_at, null);
});

test("readUsageStats returns empty stats when file is corrupt", () => {
  const file = tmpStatsFile();
  fs.writeFileSync(file, "{ not json", "utf8");
  const stats = readUsageStats(file);
  assert.equal(stats.sessions_started, 0);
  assert.equal(stats.request_approval_calls, 0);
});

test("recordSessionStart increments sessions and sets timestamps", () => {
  const file = tmpStatsFile();
  const first = recordSessionStart({ file, now: new Date("2026-06-14T08:00:00Z") });
  assert.equal(first.sessions_started, 1);
  assert.equal(first.first_session_at, "2026-06-14T08:00:00.000Z");
  assert.equal(first.last_session_at, "2026-06-14T08:00:00.000Z");
  const second = recordSessionStart({ file, now: new Date("2026-06-14T10:00:00Z") });
  assert.equal(second.sessions_started, 2);
  assert.equal(second.first_session_at, "2026-06-14T08:00:00.000Z");
  assert.equal(second.last_session_at, "2026-06-14T10:00:00.000Z");
});

test("recordApprovalCall increments approval counter and timestamp", () => {
  const file = tmpStatsFile();
  recordSessionStart({ file, now: new Date("2026-06-14T08:00:00Z") });
  const stats = recordApprovalCall({ file, now: new Date("2026-06-14T08:01:00Z") });
  assert.equal(stats.sessions_started, 1);
  assert.equal(stats.request_approval_calls, 1);
  assert.equal(stats.last_approval_at, "2026-06-14T08:01:00.000Z");
});

test("recordSessionStart preserves request_approval counter", () => {
  const file = tmpStatsFile();
  recordApprovalCall({ file });
  recordApprovalCall({ file });
  const after = recordSessionStart({ file });
  assert.equal(after.request_approval_calls, 2);
  assert.equal(after.sessions_started, 1);
});

test("pasteStepWarning returns null for wrap mode (irrelevant)", () => {
  const file = tmpStatsFile();
  for (let i = 0; i < PASTE_STEP_SESSION_THRESHOLD + 2; i += 1) recordSessionStart({ file });
  assert.equal(pasteStepWarning({ mode: "local-proxy", file }), null);
});

test("pasteStepWarning returns null for remote mode (irrelevant)", () => {
  const file = tmpStatsFile();
  for (let i = 0; i < PASTE_STEP_SESSION_THRESHOLD + 2; i += 1) recordSessionStart({ file });
  assert.equal(pasteStepWarning({ mode: "remote-bridge", file }), null);
});

test("pasteStepWarning returns null when sessions are below threshold", () => {
  const file = tmpStatsFile();
  recordSessionStart({ file });
  assert.equal(pasteStepWarning({ mode: "local-stub", file }), null);
});

test("pasteStepWarning returns null when approvals have happened", () => {
  const file = tmpStatsFile();
  for (let i = 0; i < PASTE_STEP_SESSION_THRESHOLD + 2; i += 1) recordSessionStart({ file });
  recordApprovalCall({ file });
  assert.equal(pasteStepWarning({ mode: "local-stub", file }), null);
});

test("pasteStepWarning fires when local-stub + N+ sessions + zero approvals", () => {
  const file = tmpStatsFile();
  for (let i = 0; i < PASTE_STEP_SESSION_THRESHOLD; i += 1) recordSessionStart({ file });
  const warning = pasteStepWarning({ mode: "local-stub", file });
  assert.ok(warning, "expected a warning to fire");
  assert.equal(warning.code, "paste_step_likely_missed");
  assert.equal(warning.sessions_started, PASTE_STEP_SESSION_THRESHOLD);
  assert.equal(warning.request_approval_calls, 0);
  assert.match(warning.message, /paste/i);
});

test("recordSessionStart does not throw when file path is unwritable", () => {
  // Pass an obviously bad path; helper should swallow errors and return null.
  const result = recordSessionStart({ file: "/this/path/should/not/exist/usage.json", now: new Date() });
  // We accept either the resolved stats (if the helper retried gracefully) or
  // null. The hard invariant is that we did NOT throw.
  assert.ok(result === null || typeof result === "object");
});
