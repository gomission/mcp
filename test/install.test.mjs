// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

// Tests for the @gomission/mcp install module — specifically the smart-default
// mode recommendation that picks wrap vs. local based on the user's existing
// Claude Desktop config, and the entry-builder + config-merge helpers.

import test from "node:test";
import assert from "node:assert/strict";
import { buildMissionEntry, mergeConfig, recommendMode, SERVER_KEY } from "../src/install.mjs";

test("recommendMode → wrap when one wrappable child is present", async () => {
  const existingConfig = {
    mcpServers: {
      gmail: { command: "npx", args: ["-y", "@some-vendor/gmail-mcp"] },
    },
  };
  const result = await recommendMode({ existingConfig });
  assert.equal(result.mode, "wrap");
  assert.equal(result.wrappableCount, 1);
  assert.deepEqual(result.wrappableNames, ["gmail"]);
  assert.match(result.reason, /1 wrappable/);
  assert.match(result.reason, /gmail/);
});

test("recommendMode → wrap when multiple wrappable children are present", async () => {
  const existingConfig = {
    mcpServers: {
      gmail: { command: "npx", args: ["@x/gmail"] },
      slack: { command: "npx", args: ["@x/slack"] },
      notion: { command: "npx", args: ["@x/notion"] },
    },
  };
  const result = await recommendMode({ existingConfig });
  assert.equal(result.mode, "wrap");
  assert.equal(result.wrappableCount, 3);
  assert.match(result.reason, /3 wrappable/);
});

test("recommendMode → local when no wrappable children are configured", async () => {
  const result = await recommendMode({ existingConfig: { mcpServers: {} } });
  assert.equal(result.mode, "local");
  assert.equal(result.wrappableCount, 0);
});

test("recommendMode → local when there is no existing config file", async () => {
  const result = await recommendMode({ existingConfig: null });
  assert.equal(result.mode, "local");
});

test("recommendMode → local when existing config has no mcpServers map", async () => {
  const result = await recommendMode({ existingConfig: { foo: "bar" } });
  assert.equal(result.mode, "local");
});

test("recommendMode honors MISSION_DONT_WRAP opt-out", async () => {
  const existingConfig = {
    mcpServers: {
      gmail: { command: "npx", args: ["@x/gmail"] },
    },
  };
  const optOut = new Set(["gmail"]);
  const result = await recommendMode({ existingConfig, optOut });
  assert.equal(result.mode, "local");
  assert.equal(result.wrappableCount, 0);
});

test("recommendMode skips the gomission entry itself (gate never wraps itself)", async () => {
  const existingConfig = {
    mcpServers: {
      [SERVER_KEY]: { command: "npx", args: ["-y", "@gomission/mcp", "serve"] },
    },
  };
  const result = await recommendMode({ existingConfig });
  assert.equal(result.mode, "local");
  assert.equal(result.wrappableCount, 0);
});

test("recommendMode ignores non-write children that do not match wrap heuristic", async () => {
  const existingConfig = {
    mcpServers: {
      readonly_tool: { command: "node", args: ["/some/inert/server.mjs"] },
    },
  };
  const result = await recommendMode({ existingConfig });
  assert.equal(result.mode, "local");
  assert.equal(result.wrappableCount, 0);
});

test("buildMissionEntry --wrap returns the proxy serve invocation", () => {
  const entry = buildMissionEntry({ mode: "wrap" });
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "@gomission/mcp", "serve", "--wrap"]);
});

test("buildMissionEntry --local returns the standalone serve invocation", () => {
  const entry = buildMissionEntry({ mode: "local" });
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "@gomission/mcp", "serve"]);
});

test("buildMissionEntry --remote uses mcp-remote stdio bridge", () => {
  const entry = buildMissionEntry({ mode: "remote" });
  assert.equal(entry.command, "npx");
  assert.equal(entry.args[0], "-y");
  assert.equal(entry.args[1], "mcp-remote");
  assert.match(entry.args[2], /^https?:\/\//);
});

test("mergeConfig adds gomission to an empty config", () => {
  const entry = buildMissionEntry({ mode: "remote" });
  const { config, changed } = mergeConfig({}, entry);
  assert.equal(changed, true);
  assert.deepEqual(config.mcpServers[SERVER_KEY], entry);
});

test("mergeConfig preserves unrelated mcpServers entries", () => {
  const entry = buildMissionEntry({ mode: "local" });
  const existing = { mcpServers: { gmail: { command: "x", args: [] } } };
  const { config, changed } = mergeConfig(existing, entry);
  assert.equal(changed, true);
  assert.deepEqual(config.mcpServers.gmail, { command: "x", args: [] });
  assert.deepEqual(config.mcpServers[SERVER_KEY], entry);
});
