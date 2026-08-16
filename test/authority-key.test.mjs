// Copyright (c) 2026 Phenomena Labs Ltd.
// Licensed under Apache-2.0. See LICENSE.

import assert from "node:assert/strict";
import test from "node:test";

import { bindMcpToolAction, canonicalJson, digestObject, inferActionTarget, providerActionFromMcpBinding } from "../src/authority-key.mjs";

test("exact MCP action binding is deterministic and hides the local workspace path", () => {
  const options = {
    actionClass: "email.send.external",
    workspace: "/Users/example/private-workspace",
    input: { subject: "Hello", to: "buyer@example.com", body: "Exact body" },
    now: new Date("2026-08-16T09:00:00.000Z"),
    nonce: "nonce-1",
  };
  const first = bindMcpToolAction(options);
  const second = bindMcpToolAction(options);
  assert.deepEqual(first, second);
  assert.equal(first.target, "buyer@example.com");
  assert.match(first.workspace, /^local:[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(first).includes("/Users/example"), false);
  const { actionHash, ...unsigned } = first;
  assert.equal(actionHash, digestObject(unsigned));
});

test("canonical JSON matches the Mission/Trust Graduation sorted-key subset", () => {
  assert.equal(canonicalJson({ z: 1, a: [true, undefined, { b: 2, a: 1 }] }), '{"a":[true,null,{"a":1,"b":2}],"z":1}');
  assert.equal(digestObject({ b: 2, a: 1 }), digestObject({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson(Number.NaN), /non_finite/);
});

test("target inference is conservative and deterministic", () => {
  assert.equal(inferActionTarget({ to: "person@example.com", url: "https://example.com" }), "person@example.com");
  assert.equal(inferActionTarget({ uri: "file:///safe.txt" }), "file:///safe.txt");
  assert.equal(inferActionTarget({ payload: "opaque" }), "");
});

test("MCP binding maps losslessly to the Trust core provider action shape", () => {
  const input = { to: "buyer@example.com", subject: "Hello", body: "Exact body" };
  const binding = bindMcpToolAction({
    actionClass: "email.send.external",
    workspace: "/tmp/conformance-workspace",
    requestedBy: "mcp-client",
    input,
    now: new Date("2026-08-16T09:00:00.000Z"),
    nonce: "nonce-bridge",
  });
  const action = providerActionFromMcpBinding(binding, input);

  assert.deepEqual(action, {
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
  });
  assert.throws(
    () => providerActionFromMcpBinding({ ...binding, target: "attacker@example.com" }, input),
    /integrity check failed/
  );
});
