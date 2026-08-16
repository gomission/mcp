// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Licensed under Apache-2.0. See LICENSE.

import assert from "node:assert/strict";
import test from "node:test";

import { isRecognizedModernProbeError } from "../src/verify.mjs";

test("verify never falls back to initialize after recognized modern errors", () => {
  assert.equal(isRecognizedModernProbeError(-32020), true);
  assert.equal(isRecognizedModernProbeError(-32021), true);
  assert.equal(isRecognizedModernProbeError(-32022), true);
  assert.equal(isRecognizedModernProbeError(-32601), false);
  assert.equal(isRecognizedModernProbeError(undefined), false);
});
