// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Licensed under Apache-2.0. See LICENSE.

// Mission's intentionally small portable authority boundary. Product shells,
// agent runtimes, and transports may change; these three responsibilities do
// not. This manifest is descriptive and grants no authority by itself.

export const MISSION_AUTHORITY_PROFILE = "mission-authority/v1";
export const TRUST_GRADUATION_PROFILE = "trust-graduation/0.2-beta";
export const TRUST_GRADUATION_HOME = "https://trustgraduation.org/";
export const TRUST_GRADUATION_WELL_KNOWN = "https://trustgraduation.org/.well-known/trust-graduation";
export const A2A_ACTION_AUTHORIZATION_EXTENSION = "https://trustgraduation.org/extensions/a2a/action-authorization/v1";

export function missionAuthorityManifest() {
  return {
    profile: MISSION_AUTHORITY_PROFILE,
    posture: "experimental_interoperability_profile",
    primitives: {
      gate: {
        role: "decide",
        invariant: "Evaluate one proposed action before any provider side effect.",
      },
      profile: {
        role: "evidence",
        invariant: "Authority is earned and regressed per principal and action class, never globally.",
        protocol: TRUST_GRADUATION_PROFILE,
      },
      key: {
        role: "authorize_once",
        invariant: "Bind principal, agent, workspace, tenant, action class, target, exact input digest, constraints, expiry, revocation, and one execution.",
      },
    },
    continuations: {
      a2a: {
        uri: A2A_ACTION_AUTHORIZATION_EXTENSION,
        version: "1.0",
        status: "experimental",
      },
    },
    discovery: {
      home: TRUST_GRADUATION_HOME,
      well_known: TRUST_GRADUATION_WELL_KNOWN,
    },
    claims: {
      exact_action_authority: true,
      global_agent_trust: false,
      exactly_once_provider_effect: false,
      independent_conformance_implementations: 0,
    },
  };
}

export function missionMcpCapabilities() {
  return {
    tools: {},
    experimental: {
      [MISSION_AUTHORITY_PROFILE]: missionAuthorityManifest(),
    },
  };
}
