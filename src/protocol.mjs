// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.
//
// MCP protocol version negotiation and header handling.
//
// Behavior compliant with the Model Context Protocol 2025-11-25 basic spec:
//   - Client and server exchange `protocolVersion` during `initialize`.
//   - Server accepts the client's version if supported; otherwise responds with
//     its own preferred version so the client may disconnect if incompatible.
//   - HTTP transport requires a `MCP-Protocol-Version` header on every request
//     after `initialize`. Missing, malformed, or unsupported values fail closed
//     with an explicit reason so callers cannot silently downgrade.
//
// This module has no runtime dependencies and is stable across releases: bumps
// happen only by adding new versions to the supported list, never by silently
// swapping identifiers.

// Newer versions first. Position in this array is the negotiation preference.
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2024-11-05",
]);

export const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
export const LEGACY_PROTOCOL_VERSION    = "2024-11-05";
export const CURRENT_PROTOCOL_VERSION   = "2025-11-25";

// Per MCP HTTP transport spec: subsequent requests after initialize carry this
// header. Case is preserved as documented; header names are case-insensitive on
// the wire but stable casing is friendlier to log grepping.
export const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
export const MCP_PROTOCOL_VERSION_HEADER_LOWER = MCP_PROTOCOL_VERSION_HEADER.toLowerCase();

/**
 * Return true if the given version string is in the supported list.
 * @param {string} version
 * @returns {boolean}
 */
export function isSupportedProtocolVersion(version) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(String(version || ""));
}

/**
 * Negotiate the version to use given a client-requested one.
 *
 * Returns:
 *   { ok: true, version, downgraded: boolean }
 *     - version equals the client's request when supported.
 *     - When the client's request is not supported, `version` is the server's
 *       preferred, and `downgraded` is true so the caller can log or reject.
 *   { ok: false, reason }
 *     - When no client version is supplied at all.
 *
 * The MCP lifecycle spec allows this behavior: server always answers, client
 * decides whether to continue. We never lie: we never return `version === client`
 * for a version we do not actually support.
 */
export function negotiateProtocolVersion(clientVersion) {
  if (clientVersion === undefined || clientVersion === null || clientVersion === "") {
    return { ok: false, reason: "protocol_version_missing" };
  }
  const value = String(clientVersion);
  if (isSupportedProtocolVersion(value)) {
    return { ok: true, version: value, downgraded: false };
  }
  return { ok: true, version: PREFERRED_PROTOCOL_VERSION, downgraded: true };
}

/**
 * Case-insensitive header lookup that tolerates Node's incoming.headers or a
 * plain object.
 * @param {Record<string,string|string[]>} headers
 * @returns {string}
 */
export function readProtocolVersionHeader(headers = {}) {
  const raw = headers[MCP_PROTOCOL_VERSION_HEADER] || headers[MCP_PROTOCOL_VERSION_HEADER_LOWER] || "";
  if (Array.isArray(raw)) return String(raw[0] || "");
  return String(raw || "");
}

/**
 * Validate the MCP-Protocol-Version header carried by an HTTP request. Called
 * on every request AFTER initialize. Returns:
 *   { ok: true, version }                 — supported
 *   { ok: false, reason, status: 400 }    — missing, unsupported, or malformed
 *
 * We return { ok: true } if there is no header AND the caller allows a bridge
 * mode for pre-2025-11-25 clients (opts in via `allowMissingForLegacy: true`),
 * because 2024-11-05 predates the header requirement.
 */
export function validateProtocolVersionHeader(headers, { allowMissingForLegacy = false } = {}) {
  const value = readProtocolVersionHeader(headers);
  if (!value) {
    if (allowMissingForLegacy) return { ok: true, version: LEGACY_PROTOCOL_VERSION, legacy: true };
    return { ok: false, reason: "mcp_protocol_version_header_missing", status: 400 };
  }
  if (!isSupportedProtocolVersion(value)) {
    return { ok: false, reason: `mcp_protocol_version_unsupported:${value}`, status: 400 };
  }
  return { ok: true, version: value, legacy: value === LEGACY_PROTOCOL_VERSION };
}

/**
 * Decide whether a specific authenticated workspace may use the temporary
 * headerless 2024-11-05 bridge. Compatibility is deny-by-default, explicitly
 * allowlisted, and expires at a fixed instant so it cannot become a permanent
 * protocol bypass.
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
