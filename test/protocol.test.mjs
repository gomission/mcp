// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORTED_PROTOCOL_VERSIONS,
  PREFERRED_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  CURRENT_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSION_HEADER_LOWER,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
  readProtocolVersionHeader,
  validateProtocolVersionHeader,
  legacyCompatibilityAllowed,
} from "../src/protocol.mjs";

test("supported list includes 2025-11-25 first and preserves 2024-11-05 for pilots", () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ["2025-11-25", "2024-11-05"]);
  assert.equal(PREFERRED_PROTOCOL_VERSION, "2025-11-25");
  assert.equal(CURRENT_PROTOCOL_VERSION, "2025-11-25");
  assert.equal(LEGACY_PROTOCOL_VERSION, "2024-11-05");
  assert.equal(isSupportedProtocolVersion("2025-11-25"), true);
  assert.equal(isSupportedProtocolVersion("2024-11-05"), true);
  assert.equal(isSupportedProtocolVersion("2023-01-01"), false);
  assert.equal(isSupportedProtocolVersion(""), false);
  assert.equal(isSupportedProtocolVersion(undefined), false);
});

test("negotiateProtocolVersion returns the client's version when supported and never downgrades silently", () => {
  const preferred = negotiateProtocolVersion("2025-11-25");
  assert.deepEqual(preferred, { ok: true, version: "2025-11-25", downgraded: false });
  const legacy = negotiateProtocolVersion("2024-11-05");
  assert.deepEqual(legacy, { ok: true, version: "2024-11-05", downgraded: false });
});

test("negotiateProtocolVersion downgrades to preferred and marks the response so the client can disconnect", () => {
  const future = negotiateProtocolVersion("2099-12-31");
  assert.equal(future.ok, true);
  assert.equal(future.version, "2025-11-25");
  assert.equal(future.downgraded, true);
});

test("negotiateProtocolVersion returns not-ok when the client omits the version entirely", () => {
  const missing = negotiateProtocolVersion(undefined);
  assert.deepEqual(missing, { ok: false, reason: "protocol_version_missing" });
  assert.deepEqual(negotiateProtocolVersion(""), { ok: false, reason: "protocol_version_missing" });
  assert.deepEqual(negotiateProtocolVersion(null), { ok: false, reason: "protocol_version_missing" });
});

test("readProtocolVersionHeader handles case-insensitive keys and array values", () => {
  assert.equal(readProtocolVersionHeader({ "MCP-Protocol-Version": "2025-11-25" }), "2025-11-25");
  assert.equal(readProtocolVersionHeader({ "mcp-protocol-version": "2025-11-25" }), "2025-11-25");
  assert.equal(readProtocolVersionHeader({ "mcp-protocol-version": ["2025-11-25", "2024-11-05"] }), "2025-11-25");
  assert.equal(readProtocolVersionHeader({}), "");
  assert.equal(readProtocolVersionHeader(undefined), "");
  assert.equal(MCP_PROTOCOL_VERSION_HEADER, "MCP-Protocol-Version");
  assert.equal(MCP_PROTOCOL_VERSION_HEADER_LOWER, "mcp-protocol-version");
});

test("validateProtocolVersionHeader fails closed on missing header when legacy mode is off", () => {
  const result = validateProtocolVersionHeader({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, "mcp_protocol_version_header_missing");
  assert.equal(result.status, 400);
});

test("validateProtocolVersionHeader allows a missing header only when legacy compatibility is explicitly requested", () => {
  const result = validateProtocolVersionHeader({}, { allowMissingForLegacy: true });
  assert.equal(result.ok, true);
  assert.equal(result.version, "2024-11-05");
  assert.equal(result.legacy, true);
});

test("validateProtocolVersionHeader rejects an unsupported header value with a specific reason", () => {
  const result = validateProtocolVersionHeader({ "mcp-protocol-version": "2099-12-31" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.reason, /^mcp_protocol_version_unsupported:2099-12-31$/);
});

test("validateProtocolVersionHeader accepts both supported versions and flags legacy explicitly", () => {
  const preferred = validateProtocolVersionHeader({ "mcp-protocol-version": "2025-11-25" });
  assert.equal(preferred.ok, true);
  assert.equal(preferred.version, "2025-11-25");
  assert.equal(preferred.legacy, false);
  const legacy = validateProtocolVersionHeader({ "mcp-protocol-version": "2024-11-05" });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.version, "2024-11-05");
  assert.equal(legacy.legacy, true);
});

test("readProtocolVersionHeader rejects an obviously malformed header value gracefully", () => {
  // Non-string values (e.g. a number sent by a broken client) are coerced to
  // string; the downstream validator will then reject.
  const numericAsHeader = validateProtocolVersionHeader({ "mcp-protocol-version": 20250101 });
  assert.equal(numericAsHeader.ok, false);
  assert.match(numericAsHeader.reason, /^mcp_protocol_version_unsupported:/);
});

test("legacy compatibility is workspace-bound, explicit, and time-limited", () => {
  const options = {
    workspaceId: "pilot-a",
    allowlist: "pilot-a,pilot-b",
    expiresAt: "2026-08-01T00:00:00.000Z",
  };
  assert.equal(legacyCompatibilityAllowed({ ...options, at: new Date("2026-07-11T00:00:00.000Z") }), true);
  assert.equal(legacyCompatibilityAllowed({ ...options, workspaceId: "pilot-c", at: new Date("2026-07-11T00:00:00.000Z") }), false);
  assert.equal(legacyCompatibilityAllowed({ ...options, at: new Date("2026-08-01T00:00:00.000Z") }), false);
  assert.equal(legacyCompatibilityAllowed({ workspaceId: "pilot-a", allowlist: "pilot-a", at: new Date("2026-07-11T00:00:00.000Z") }), false);
});
