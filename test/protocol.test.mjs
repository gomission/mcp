// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Licensed under Apache-2.0. See LICENSE.

import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORTED_PROTOCOL_VERSIONS,
  PREFERRED_PROTOCOL_VERSION,
  LEGACY_PREFERRED_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  CURRENT_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSION_HEADER_LOWER,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION_META_KEY,
  MCP_CLIENT_CAPABILITIES_META_KEY,
  HEADER_MISMATCH_ERROR,
  UNSUPPORTED_PROTOCOL_VERSION_ERROR,
  isSupportedProtocolVersion,
  isModernProtocolVersion,
  negotiateProtocolVersion,
  readProtocolVersionHeader,
  readRequestProtocolVersion,
  validateProtocolVersionHeader,
  validateModernRequestMetadata,
  validateModernHttpRequest,
  decodeMcpHeaderValue,
  modernDiscoverResult,
  modernCompleteResult,
  legacyCompatibilityAllowed,
} from "../src/protocol.mjs";

function modernMessage(method = "tools/list", params = {}) {
  return {
    jsonrpc: "2.0",
    id: 7,
    method,
    params: {
      ...params,
      _meta: {
        [MCP_PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  };
}

function modernHeaders(method = "tools/list", extra = {}) {
  return {
    [MCP_PROTOCOL_VERSION_HEADER]: MODERN_PROTOCOL_VERSION,
    [MCP_METHOD_HEADER]: method,
    ...extra,
  };
}

test("supported list prefers stateless 2026-07-28 and preserves both initialize-era versions", () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ["2026-07-28", "2025-11-25", "2024-11-05"]);
  assert.equal(PREFERRED_PROTOCOL_VERSION, "2026-07-28");
  assert.equal(CURRENT_PROTOCOL_VERSION, "2026-07-28");
  assert.equal(MODERN_PROTOCOL_VERSION, "2026-07-28");
  assert.equal(LEGACY_PREFERRED_PROTOCOL_VERSION, "2025-11-25");
  assert.equal(LEGACY_PROTOCOL_VERSION, "2024-11-05");
  assert.equal(isSupportedProtocolVersion("2026-07-28"), true);
  assert.equal(isSupportedProtocolVersion("2025-11-25"), true);
  assert.equal(isSupportedProtocolVersion("2024-11-05"), true);
  assert.equal(isModernProtocolVersion("2026-07-28"), true);
  assert.equal(isModernProtocolVersion("2025-11-25"), false);
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

test("initialize negotiation stays in the legacy era and marks a downgrade", () => {
  const future = negotiateProtocolVersion("2099-12-31");
  assert.equal(future.ok, true);
  assert.equal(future.version, "2025-11-25");
  assert.equal(future.downgraded, true);

  const modernViaInitialize = negotiateProtocolVersion("2026-07-28");
  assert.deepEqual(modernViaInitialize, { ok: true, version: "2025-11-25", downgraded: true });
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
  assert.equal(readProtocolVersionHeader({ "mCp-PrOtOcOl-VeRsIoN": "2025-11-25" }), "2025-11-25");
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
  const modern = validateProtocolVersionHeader({ "mcp-protocol-version": "2026-07-28" });
  assert.equal(modern.ok, true);
  assert.equal(modern.modern, true);
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

test("modern request metadata is mandatory and transport-neutral", () => {
  const valid = modernMessage();
  assert.equal(readRequestProtocolVersion(valid), MODERN_PROTOCOL_VERSION);
  assert.equal(validateModernRequestMetadata(valid).ok, true);

  const noCapabilities = modernMessage();
  delete noCapabilities.params._meta[MCP_CLIENT_CAPABILITIES_META_KEY];
  const missing = validateModernRequestMetadata(noCapabilities);
  assert.equal(missing.ok, false);
  assert.equal(missing.response.error.code, -32602);

  const unsupported = modernMessage();
  unsupported.params._meta[MCP_PROTOCOL_VERSION_META_KEY] = "2099-12-31";
  const rejected = validateModernRequestMetadata(unsupported);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.response.error.code, UNSUPPORTED_PROTOCOL_VERSION_ERROR);
  assert.deepEqual(rejected.response.error.data.supported, [...SUPPORTED_PROTOCOL_VERSIONS]);
});

test("modern HTTP binds version, method, and tool name headers to the request body", () => {
  const list = modernMessage();
  assert.equal(validateModernHttpRequest(list, modernHeaders()).ok, true);

  const call = modernMessage("tools/call", { name: "mission_status", arguments: {} });
  const headers = modernHeaders("tools/call", { [MCP_NAME_HEADER]: "mission_status" });
  assert.equal(validateModernHttpRequest(call, headers).ok, true);

  const wrongMethod = validateModernHttpRequest(call, { ...headers, [MCP_METHOD_HEADER]: "tools/list" });
  assert.equal(wrongMethod.ok, false);
  assert.equal(wrongMethod.status, 400);
  assert.equal(wrongMethod.response.error.code, HEADER_MISMATCH_ERROR);

  const wrongName = validateModernHttpRequest(call, { ...headers, [MCP_NAME_HEADER]: "other_tool" });
  assert.equal(wrongName.ok, false);
  assert.equal(wrongName.response.error.code, HEADER_MISMATCH_ERROR);
});

test("modern HTTP accepts the exact Base64 sentinel for a non-ASCII Mcp-Name", () => {
  const name = "mission_שלום";
  const call = modernMessage("tools/call", { name, arguments: {} });
  const encoded = `=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`;
  const decoded = decodeMcpHeaderValue(encoded);
  assert.deepEqual(decoded, { ok: true, value: name, encoded: true });
  assert.equal(validateModernHttpRequest(call, modernHeaders("tools/call", { [MCP_NAME_HEADER]: encoded })).ok, true);
  assert.equal(decodeMcpHeaderValue("=?base64?broken?=").ok, false);
  assert.equal(decodeMcpHeaderValue(" padded ").reason, "unsafe_plain_header_whitespace");
  assert.deepEqual(decodeMcpHeaderValue("partial?="), { ok: true, value: "partial?=", encoded: false });
  assert.equal(decodeMcpHeaderValue("=?base64?/w==?=").reason, "invalid_base64_value");
});

test("modern HTTP returns protocol-defined errors for header mismatch and unsupported versions", () => {
  const message = modernMessage();
  const missing = validateModernHttpRequest(message, {});
  assert.equal(missing.response.error.code, HEADER_MISMATCH_ERROR);

  const unsupported = modernMessage();
  unsupported.params._meta[MCP_PROTOCOL_VERSION_META_KEY] = "2099-12-31";
  const rejected = validateModernHttpRequest(unsupported, {
    [MCP_PROTOCOL_VERSION_HEADER]: "2099-12-31",
    [MCP_METHOD_HEADER]: "tools/list",
  });
  assert.equal(rejected.response.error.code, UNSUPPORTED_PROTOCOL_VERSION_ERROR);
  assert.deepEqual(rejected.response.error.data, {
    supported: [...SUPPORTED_PROTOCOL_VERSIONS],
    requested: "2099-12-31",
  });
});

test("modern discovery and complete results expose the 2026 response contract", () => {
  const discovery = modernDiscoverResult({ name: "mission-test", version: "1.2.3" });
  assert.equal(discovery.resultType, "complete");
  assert.deepEqual(discovery.supportedVersions, [...SUPPORTED_PROTOCOL_VERSIONS]);
  assert.deepEqual(discovery._meta["io.modelcontextprotocol/serverInfo"], { name: "mission-test", version: "1.2.3" });
  assert.deepEqual(modernCompleteResult({ tools: [] }), { resultType: "complete", tools: [] });
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
