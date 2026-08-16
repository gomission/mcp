// Copyright (c) 2026 Phenomena Labs Ltd.
// Licensed under Apache-2.0. See LICENSE.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runHoldDemo } from "../src/demo.mjs";

test("one-command demo proves a consequential call is held before the provider", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mission-mcp-demo-test-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let output = "";
  const result = await runHoldDemo({ workspace, stdout: { write: (value) => { output += value; } } });
  assert.equal(result.ok, true);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.mutation_changes_input_hash, true);
  assert.equal(result.chat_reply_grants_authority, false);
  assert.match(result.action_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(output, /^DEMO_RESULT /);
  assert.equal(fs.existsSync(result.receipt_file), true);
});
