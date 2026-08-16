// Copyright (c) 2026 Phenomena Labs Ltd.
// Licensed under Apache-2.0. See LICENSE.

import crypto from "node:crypto";
import path from "node:path";

// This is the same deterministic JSON subset used by @trust-graduation/core
// and @gomission/mission-schemas. A binding-version change is required before
// changing these canonicalization rules.
export function canonicalJson(value) {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_json_non_finite_number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error(`canonical_json_unsupported_type:${typeof value}`);
}

export function digestObject(value) {
  return `sha256:${crypto.createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`;
}

export function localWorkspaceId(workspace = "") {
  return `local:${crypto.createHash("sha256").update(path.resolve(String(workspace || "."))).digest("hex").slice(0, 24)}`;
}

export function inferActionTarget(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const candidates = [
    input.target,
    input.to,
    input.recipient,
    input.email,
    input.uri,
    input.url,
    input.resource,
    input.record_id,
    input.id,
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  return String(value || "").trim();
}

/** Build a Trust Graduation v1 exact-action binding for an intercepted call. */
export function bindMcpToolAction({
  actionClass,
  workspace,
  requestedBy = "mcp-client",
  target,
  input = {},
  constraints = { scope: "once", maxExecutions: 1 },
  now = new Date(),
  expiresInMs = 10 * 60 * 1000,
  nonce = crypto.randomUUID(),
} = {}) {
  if (!String(actionClass || "").trim()) throw new Error("actionClass is required");
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error("invalid binding time");
  const workspaceId = localWorkspaceId(workspace);
  const binding = {
    protocol: "trust-graduation-action-binding",
    version: "1.0",
    actionClass: String(actionClass),
    workspace: workspaceId,
    principal: workspaceId,
    requestedBy: String(requestedBy || "mcp-client"),
    tenant: workspaceId,
    target: String(target ?? inferActionTarget(input)),
    inputHash: digestObject(input ?? {}),
    constraints: constraints && typeof constraints === "object" ? constraints : {},
    expiresAt: new Date(at.getTime() + Math.max(1, Number(expiresInMs) || 1)).toISOString(),
    nonce: String(nonce),
  };
  return { ...binding, actionHash: digestObject(binding) };
}

/** Map an intercepted MCP binding plus the actual provider input to the core gate action shape. */
export function providerActionFromMcpBinding(binding, input) {
  if (!binding?.actionHash) throw new Error("binding.actionHash is required");
  if (binding.protocol !== "trust-graduation-action-binding" || binding.version !== "1.0") {
    throw new Error("binding protocol is invalid");
  }
  const { actionHash, ...unsigned } = binding;
  if (digestObject(unsigned) !== actionHash) throw new Error("binding integrity check failed");

  return {
    actionClass: binding.actionClass,
    workspace: binding.workspace,
    principal: binding.principal,
    requestedBy: binding.requestedBy,
    tenant: binding.tenant,
    target: binding.target,
    input,
    constraints: binding.constraints,
    expiresAt: binding.expiresAt,
    nonce: binding.nonce,
  };
}
