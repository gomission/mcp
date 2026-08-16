// Copyright (c) 2026 Phenomena Labs Ltd.
// Licensed under Apache-2.0. See LICENSE.

export {
  bindMcpToolAction,
  canonicalJson,
  digestObject,
  inferActionTarget,
  localWorkspaceId,
  providerActionFromMcpBinding,
} from "./authority-key.mjs";

export {
  A2A_ACTION_AUTHORIZATION_EXTENSION,
  MISSION_AUTHORITY_PROFILE,
  TRUST_GRADUATION_HOME,
  TRUST_GRADUATION_PROFILE,
  TRUST_GRADUATION_WELL_KNOWN,
  missionAuthorityManifest,
  missionMcpCapabilities,
} from "./authority-profile.mjs";
