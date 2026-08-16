// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Licensed under Apache-2.0. See LICENSE.
//
// MCP protocol-era compatibility and HTTP request binding.
//
// MCP 2026-07-28 is stateless: every request declares its protocol version and
// client capabilities in params._meta. Older MCP clients select a version with
// initialize and may retain session semantics. Mission deliberately supports
// both eras without pretending that initialize can negotiate the modern era.

import { TextDecoder } from "node:util";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_CURRENT_PROTOCOL_VERSION = "2025-11-25";
export const LEGACY_PROTOCOL_VERSION = "2024-11-05";

// Newer versions first. This list is also advertised by server/discover and in
// UnsupportedProtocolVersionError responses.
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  MODERN_PROTOCOL_VERSION,
  LEGACY_CURRENT_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
]);

// `initialize` belongs to the legacy era. It must never answer with 2026-07-28,
// even though that is Mission's preferred protocol for stateless requests.
export const LEGACY_INITIALIZATION_PROTOCOL_VERSIONS = Object.freeze([
  LEGACY_CURRENT_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
]);
export const LEGACY_PREFERRED_PROTOCOL_VERSION = LEGACY_INITIALIZATION_PROTOCOL_VERSIONS[0];

export const PREFERRED_PROTOCOL_VERSION = MODERN_PROTOCOL_VERSION;
export const CURRENT_PROTOCOL_VERSION = MODERN_PROTOCOL_VERSION;

export const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
export const MCP_PROTOCOL_VERSION_HEADER_LOWER = MCP_PROTOCOL_VERSION_HEADER.toLowerCase();
export const MCP_METHOD_HEADER = "Mcp-Method";
export const MCP_METHOD_HEADER_LOWER = MCP_METHOD_HEADER.toLowerCase();
export const MCP_NAME_HEADER = "Mcp-Name";
export const MCP_NAME_HEADER_LOWER = MCP_NAME_HEADER.toLowerCase();

export const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const MCP_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

export const HEADER_MISMATCH_ERROR = -32020;
export const MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR = -32021;
export const UNSUPPORTED_PROTOCOL_VERSION_ERROR = -32022;

const NAMED_REQUEST_FIELDS = Object.freeze({
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
});

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readHeader(headers = {}, canonicalName, lowerName = canonicalName.toLowerCase()) {
  if (!headers || typeof headers !== "object") return "";
  let raw = headers[canonicalName] ?? headers[lowerName];
  if (raw === undefined) {
    for (const [name, value] of Object.entries(headers)) {
      if (String(name).toLowerCase() === lowerName) {
        raw = value;
        break;
      }
    }
  }
  if (Array.isArray(raw)) return String(raw[0] || "");
  return String(raw || "");
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  const response = { jsonrpc: "2.0", id: id ?? null, error };
  return response;
}

function headerMismatch(id, message) {
  return {
    ok: false,
    status: 400,
    reason: "mcp_header_mismatch",
    response: jsonRpcError(id, HEADER_MISMATCH_ERROR, `Header mismatch: ${message}`),
  };
}

function unsupportedVersion(id, requested) {
  return {
    ok: false,
    status: 400,
    reason: `mcp_protocol_version_unsupported:${requested || "<missing>"}`,
    response: jsonRpcError(id, UNSUPPORTED_PROTOCOL_VERSION_ERROR, "Unsupported protocol version", {
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      requested: String(requested || ""),
    }),
  };
}

/** Return true when Mission implements a protocol version. */
export function isSupportedProtocolVersion(version) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(String(version || ""));
}

/** Return true only for the stateless, per-request-metadata protocol era. */
export function isModernProtocolVersion(version) {
  return String(version || "") === MODERN_PROTOCOL_VERSION;
}

/**
 * Negotiate an initialize-era version.
 *
 * Modern 2026-07-28 requests do not initialize. Consequently, this helper
 * accepts only versions that can actually participate in the legacy lifecycle.
 */
export function negotiateProtocolVersion(clientVersion) {
  if (clientVersion === undefined || clientVersion === null || clientVersion === "") {
    return { ok: false, reason: "protocol_version_missing" };
  }
  const value = String(clientVersion);
  if (LEGACY_INITIALIZATION_PROTOCOL_VERSIONS.includes(value)) {
    return { ok: true, version: value, downgraded: false };
  }
  return { ok: true, version: LEGACY_PREFERRED_PROTOCOL_VERSION, downgraded: true };
}

/** Case-insensitive MCP-Protocol-Version lookup. */
export function readProtocolVersionHeader(headers = {}) {
  return readHeader(headers, MCP_PROTOCOL_VERSION_HEADER, MCP_PROTOCOL_VERSION_HEADER_LOWER);
}

/** Case-insensitive Mcp-Method lookup. */
export function readMethodHeader(headers = {}) {
  return readHeader(headers, MCP_METHOD_HEADER, MCP_METHOD_HEADER_LOWER);
}

/** Case-insensitive Mcp-Name lookup. */
export function readNameHeader(headers = {}) {
  return readHeader(headers, MCP_NAME_HEADER, MCP_NAME_HEADER_LOWER);
}

/** Read the modern protocol version carried in request params._meta. */
export function readRequestProtocolVersion(message = {}) {
  return String(message?.params?._meta?.[MCP_PROTOCOL_VERSION_META_KEY] || "");
}

/** Read the modern client capability declaration carried on every request. */
export function readRequestClientCapabilities(message = {}) {
  return message?.params?._meta?.[MCP_CLIENT_CAPABILITIES_META_KEY];
}

/**
 * Validate a modern request's required per-request metadata.
 * This transport-neutral check is used by both stdio and HTTP dispatch.
 */
export function validateModernRequestMetadata(message = {}) {
  const id = message?.id;
  const requested = readRequestProtocolVersion(message);
  if (!requested) {
    return {
      ok: false,
      reason: "mcp_request_protocol_version_missing",
      response: jsonRpcError(id, -32602, "Invalid params: required protocolVersion request metadata is missing"),
    };
  }
  if (!isSupportedProtocolVersion(requested)) return unsupportedVersion(id, requested);
  if (!isModernProtocolVersion(requested)) {
    return {
      ok: false,
      reason: `mcp_protocol_version_requires_initialize:${requested}`,
      response: jsonRpcError(id, -32602, `Protocol version ${requested} requires the legacy initialize lifecycle`),
    };
  }
  const capabilities = readRequestClientCapabilities(message);
  if (!isObject(capabilities)) {
    return {
      ok: false,
      reason: "mcp_client_capabilities_missing",
      response: jsonRpcError(id, -32602, "Invalid params: required clientCapabilities request metadata is missing"),
    };
  }
  return { ok: true, version: requested, modern: true, clientCapabilities: capabilities };
}

/**
 * Decode the spec's exact =?base64?...?= sentinel format.
 * Plain visible-ASCII values are returned unchanged. Invalid encodings fail.
 */
export function decodeMcpHeaderValue(value) {
  const raw = String(value ?? "");
  const sentinel = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(raw);
  if (!sentinel) {
    if (raw.startsWith("=?base64?") && raw.endsWith("?=")) {
      return { ok: false, reason: "invalid_base64_sentinel" };
    }
    if (!/^[\x20-\x7e\t]*$/.test(raw)) return { ok: false, reason: "invalid_header_characters" };
    if (/^[ \t]|[ \t]$/.test(raw)) return { ok: false, reason: "unsafe_plain_header_whitespace" };
    return { ok: true, value: raw, encoded: false };
  }
  const encoded = sentinel[1];
  if (encoded.length % 4 !== 0) return { ok: false, reason: "invalid_base64_length" };
  try {
    const decodedBuffer = Buffer.from(encoded, "base64");
    if (decodedBuffer.toString("base64") !== encoded) return { ok: false, reason: "invalid_base64_value" };
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(decodedBuffer);
    return { ok: true, value: decoded, encoded: true };
  } catch {
    return { ok: false, reason: "invalid_base64_value" };
  }
}

/**
 * Validate the 2026-07-28 HTTP header/body binding for one JSON-RPC request.
 * Legacy versions intentionally retain the earlier header-only behavior.
 */
export function validateModernHttpRequest(message = {}, headers = {}) {
  const id = message?.id;
  const headerVersion = readProtocolVersionHeader(headers);
  const bodyVersion = readRequestProtocolVersion(message);

  if (!headerVersion) return headerMismatch(id, `${MCP_PROTOCOL_VERSION_HEADER} is required`);
  if (!bodyVersion) return headerMismatch(id, `${MCP_PROTOCOL_VERSION_HEADER} has no matching request metadata`);
  if (headerVersion !== bodyVersion) {
    return headerMismatch(id, `${MCP_PROTOCOL_VERSION_HEADER} value '${headerVersion}' does not match body value '${bodyVersion}'`);
  }
  if (!isSupportedProtocolVersion(headerVersion)) return unsupportedVersion(id, headerVersion);
  if (!isModernProtocolVersion(headerVersion)) {
    return { ok: true, version: headerVersion, modern: false };
  }

  const metadata = validateModernRequestMetadata(message);
  if (!metadata.ok) return { ...metadata, status: metadata.status || 400 };

  const methodHeader = readMethodHeader(headers);
  if (!methodHeader) return headerMismatch(id, `${MCP_METHOD_HEADER} is required`);
  if (methodHeader !== String(message?.method || "")) {
    return headerMismatch(id, `${MCP_METHOD_HEADER} value '${methodHeader}' does not match body value '${message?.method || ""}'`);
  }

  const sourceField = NAMED_REQUEST_FIELDS[message?.method];
  if (sourceField) {
    const bodyName = message?.params?.[sourceField];
    const nameHeader = readNameHeader(headers);
    if (bodyName === undefined || bodyName === null || bodyName === "") {
      return headerMismatch(id, `${MCP_NAME_HEADER} has no corresponding params.${sourceField} body value`);
    }
    if (!nameHeader) return headerMismatch(id, `${MCP_NAME_HEADER} is required for ${message.method}`);
    const decoded = decodeMcpHeaderValue(nameHeader);
    if (!decoded.ok) return headerMismatch(id, `${MCP_NAME_HEADER} is malformed`);
    if (decoded.value !== String(bodyName)) {
      return headerMismatch(id, `${MCP_NAME_HEADER} value '${decoded.value}' does not match body value '${bodyName}'`);
    }
  }

  return { ...metadata, http: true };
}

/**
 * Earlier HTTP-era header validation, retained for 2025/2024 clients.
 * Modern callers should use validateModernHttpRequest so headers are bound to
 * the JSON-RPC body rather than merely checked for membership in a list.
 */
export function validateProtocolVersionHeader(headers, { allowMissingForLegacy = false } = {}) {
  const value = readProtocolVersionHeader(headers);
  if (!value) {
    if (allowMissingForLegacy) return { ok: true, version: LEGACY_PROTOCOL_VERSION, legacy: true, modern: false };
    return { ok: false, reason: "mcp_protocol_version_header_missing", status: 400 };
  }
  if (!isSupportedProtocolVersion(value)) {
    return { ok: false, reason: `mcp_protocol_version_unsupported:${value}`, status: 400 };
  }
  return {
    ok: true,
    version: value,
    legacy: value === LEGACY_PROTOCOL_VERSION,
    modern: isModernProtocolVersion(value),
  };
}

/** Build the mandatory modern discovery result. */
export function modernDiscoverResult({
  name = "mission",
  version = "0.3.0-beta.1",
  capabilities = { tools: {} },
  instructions = "Mission is an authority layer for consequential agent actions.",
  ttlMs = 300000,
  cacheScope = "private",
} = {}) {
  return {
    resultType: "complete",
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities,
    _meta: { [MCP_SERVER_INFO_META_KEY]: { name, version } },
    instructions,
    ttlMs,
    cacheScope,
  };
}

/** Add the modern complete-result discriminator without mutating tool output. */
export function modernCompleteResult(result = {}) {
  return { resultType: "complete", ...(isObject(result) ? result : { value: result }) };
}

/**
 * Decide whether a specific authenticated workspace may use the temporary
 * headerless 2024-11-05 bridge. Compatibility is deny-by-default, explicitly
 * allowlisted, and expires at a fixed instant.
 */
export function legacyCompatibilityAllowed({ workspaceId = "", allowlist = "", expiresAt = "", at = new Date() } = {}) {
  const allowedIds = String(allowlist || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!workspaceId || !allowedIds.includes(String(workspaceId))) return false;
  const expiryMs = Date.parse(String(expiresAt || ""));
  const atMs = at instanceof Date ? at.getTime() : Date.parse(String(at || ""));
  return Number.isFinite(expiryMs) && Number.isFinite(atMs) && atMs < expiryMs;
}
