// Copyright (c) 2026 Phenomena Labs Ltd.
// Licensed under Apache-2.0. See LICENSE.

import assert from "node:assert/strict";
import test from "node:test";

import {
  A2A_ACTION_AUTHORIZATION_EXTENSION,
  MISSION_AUTHORITY_PROFILE,
  missionAuthorityManifest,
  missionMcpCapabilities,
} from "../src/authority-profile.mjs";

test("authority manifest keeps Gate, Profile, and Key as separate responsibilities", () => {
  const manifest = missionAuthorityManifest();
  assert.equal(manifest.profile, MISSION_AUTHORITY_PROFILE);
  assert.deepEqual(Object.keys(manifest.primitives), ["gate", "profile", "key"]);
  assert.equal(manifest.primitives.gate.role, "decide");
  assert.equal(manifest.primitives.profile.role, "evidence");
  assert.equal(manifest.primitives.key.role, "authorize_once");
  assert.equal(manifest.claims.exactly_once_provider_effect, false);
  assert.equal(manifest.claims.independent_conformance_implementations, 0);
});

test("MCP discovery advertises the A2A exact-action continuation as experimental", () => {
  const capabilities = missionMcpCapabilities();
  const manifest = capabilities.experimental[MISSION_AUTHORITY_PROFILE];
  assert.equal(manifest.continuations.a2a.uri, A2A_ACTION_AUTHORIZATION_EXTENSION);
  assert.equal(manifest.continuations.a2a.status, "experimental");
});
