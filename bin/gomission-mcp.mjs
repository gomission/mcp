#!/usr/bin/env node
// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Proprietary and confidential. See LICENSE.

// Lazy-import sub-modules so `--help`/`--version` work even if the optional
// serve dependencies are not yet on disk.

const [, , command, ...rest] = process.argv;

function usage() {
  process.stderr.write(
`gomission-mcp <command>

Commands:
  install-claude    Add Mission to Claude Desktop's MCP config.
  verify            Check the install: config present, mode classified,
                    remote endpoint probed with initialize + tools/list.
  serve             Run the local Mission MCP server (used by --local installs).
  --version         Print the package version.
  --help            Show this help.

verify flags:
  --json            Emit a machine-readable report instead of human text.
  --no-probe        Skip the live endpoint round-trip.

install-claude flags:
  (no flag)         Auto-recommend a mode based on your existing config:
                    --wrap if other MCP servers are configured; otherwise
                    --local. The remote read-only path is never auto-picked.
  --remote          Use the hosted Mission MCP at gomission.io/mcp/. Read-only
                    by protocol — Mission is visible as a tool but does NOT
                    gate consequential actions. Lowest-friction install.
  --local           Use a local stdio MCP server with the Trust Graduation
                    approval ceremony for consequential actions. Requires a
                    one-time system-prompt instruction (printed after install).
  --wrap            Use the local Mission proxy: wraps the other mcpServers
                    in Claude Desktop's config and gates their tool calls
                    through Trust Graduation. Opt out per-server with
                    MISSION_DONT_WRAP="server1,server2". No system-prompt
                    instruction needed — gating is automatic per tool call.
  --token <bearer>  Bearer token for the remote MCP (optional; OAuth flow runs
                    inside Claude Desktop if omitted).
  --remote-url <u>  Override the remote MCP URL (default https://gomission.io/mcp/).
  --workspace <dir> Local-mode only: bridge receipts to an existing Mission workspace.
  --dry-run         Print the planned change without writing.
  --force           Write the config even if Claude Desktop is not yet installed.

serve flags:
  --wrap            Run the proxy instead of the standalone Trust Graduation
                    gate. Wraps the other mcpServers from Claude Desktop's
                    config and gates each tool call.

After install:
  Restart Claude Desktop. Mission gates consequential actions until you approve.

Learn more: https://claude.gomission.io
`,
  );
}

function flags(args) {
  const out = {
    mode: null,            // null = auto-recommend based on existing config
    explicitMode: false,
    wrap: false,
    dryRun: false,
    force: false,
    workspace: process.env.MISSION_WORKSPACE || "",
    token: process.env.GOMISSION_TOKEN || "",
    remoteUrl: "",
    json: false,
    probe: true,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--remote") { out.mode = "remote"; out.explicitMode = true; }
    else if (a === "--local") { out.mode = "local"; out.explicitMode = true; }
    else if (a === "--wrap") { out.mode = "wrap"; out.explicitMode = true; out.wrap = true; }
    else if (a === "--workspace") out.workspace = args[i + 1] || "";
    else if (a === "--token") out.token = args[i + 1] || "";
    else if (a === "--remote-url") out.remoteUrl = args[i + 1] || "";
    else if (a === "--json") out.json = true;
    else if (a === "--no-probe") out.probe = false;
  }
  return out;
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }
  if (command === "--version" || command === "-v") {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync(pkgUrl, "utf8"));
    process.stdout.write(`${pkg.version}\n`);
    process.exit(0);
  }
  if (command === "install-claude") {
    const opts = flags(rest);
    if (!opts.explicitMode) {
      try {
        const fs = await import("node:fs");
        const { claudeConfigPath, readExistingConfig, recommendMode } = await import("../src/install.mjs");
        const configFile = claudeConfigPath();
        let existing = null;
        try {
          existing = fs.existsSync(configFile) ? readExistingConfig(configFile) : null;
        } catch {
          existing = null;
        }
        const rec = await recommendMode({ existingConfig: existing });
        opts.mode = rec.mode;
        process.stdout.write(`No mode flag provided. Auto-selected --${rec.mode}.\n`);
        process.stdout.write(`Reason: ${rec.reason}\n`);
        process.stdout.write(`Override with --remote (read-only), --local (approval ceremony), or --wrap (proxy other MCP servers).\n\n`);
      } catch {
        opts.mode = "local";
      }
    }
    const installOpts = {
      mode: opts.mode,
      dryRun: opts.dryRun,
      force: opts.force,
      workspace: opts.workspace,
      token: opts.token,
    };
    if (opts.remoteUrl) installOpts.remoteUrl = opts.remoteUrl;
    try {
      const { installClaudeDesktop } = await import("../src/install.mjs");
      const result = await installClaudeDesktop(installOpts);
      if (opts.dryRun) {
        process.stdout.write(`Would write Claude Desktop config at: ${result.configFile}\n`);
        process.stdout.write(`${JSON.stringify(result.config, null, 2)}\n`);
      } else {
        process.stdout.write(`Mission installed (${result.mode}) in Claude Desktop config: ${result.configFile}\n`);
        if (result.mode === "remote") {
          process.stdout.write("Restart Claude Desktop. The first time you use Mission in a chat, sign in to gomission.io.\n");
          process.stdout.write("\n");
          process.stdout.write("Important: this is the read-only mode. Mission is visible as a tool but does\n");
          process.stdout.write("NOT gate consequential actions. Claude can still send email, post, spend, or\n");
          process.stdout.write("modify external records through any other MCP server you have installed.\n");
          process.stdout.write("\n");
          process.stdout.write("For actual gating:\n");
          process.stdout.write("  - If you have other MCP servers (gmail, slack, ...) — re-run with --wrap.\n");
          process.stdout.write("  - For Mission's own approval ceremony — re-run with --local.\n");
        } else if (result.mode === "wrap") {
          process.stdout.write("Restart Claude Desktop. Mission will wrap every other MCP server in your config\n");
          process.stdout.write("and gate each tool call through Trust Graduation classification.\n");
          process.stdout.write("\n");
          process.stdout.write("Wrap mode is automatic: you do NOT need to tell Claude to use Mission. Every\n");
          process.stdout.write("call to a wrapped tool (gmail/send_email, slack/post_message, etc.) is\n");
          process.stdout.write("intercepted, classified, and either blocked with a ceremony or forwarded.\n");
          process.stdout.write("\n");
          process.stdout.write("Opt out per-server: set MISSION_DONT_WRAP=\"server1,server2\" in the gomission\n");
          process.stdout.write("env block of claude_desktop_config.json.\n");
          process.stdout.write("\nLearn more: https://claude.gomission.io\n");
        } else {
          process.stdout.write("Restart Claude Desktop. Mission will gate consequential actions until you approve.\n");
          // The most important step: without this instruction Claude won't
          // actually route consequential actions through the gate. Mission is
          // available as a tool but Claude has no built-in mapping that says
          // "this is consequential, ask Mission first." The user must tell it.
          process.stdout.write("\n");
          process.stdout.write("=============================================================\n");
          process.stdout.write(" STEP 3 (REQUIRED): Tell Claude to actually use Mission\n");
          process.stdout.write("=============================================================\n");
          process.stdout.write("Paste this into Claude Desktop's Settings -> Profile ->\n");
          process.stdout.write("Personal preferences, OR at the top of any Mission session:\n");
          process.stdout.write("\n");
          process.stdout.write("> Mission is my permission layer. Before any external action\n");
          process.stdout.write("> (send email, post publicly, schedule, spend, publish, modify\n");
          process.stdout.write("> external records), call the request_approval tool with\n");
          process.stdout.write("> action_class and a one-line summary, then call\n");
          process.stdout.write("> mission_check_approval until decision=approved. Do not act\n");
          process.stdout.write("> until approved. If denied, stop and tell me. If unsure\n");
          process.stdout.write("> which action_class applies, call mission_classify first.\n");
          process.stdout.write("\n");
          process.stdout.write("Without this instruction Claude will not gate actions even\n");
          process.stdout.write("though Mission is installed.\n");
          process.stdout.write("\n");
          process.stdout.write("Test it: ask Claude 'send an email to me at <your address>'\n");
          process.stdout.write("and watch for the approval ceremony in the response.\n");
          process.stdout.write("\nLearn more: https://claude.gomission.io\n");
        }
      }
      process.exit(0);
    } catch (error) {
      if (error.code === "CLAUDE_NOT_FOUND") {
        process.stderr.write("Claude Desktop config directory not found. Install Claude Desktop first, or rerun with --force.\n");
        process.exit(2);
      }
      process.stderr.write(`Install failed: ${error.message}\n`);
      process.exit(1);
    }
  }
  if (command === "verify") {
    const opts = flags(rest);
    try {
      const { verifyInstall } = await import("../src/verify.mjs");
      const exitCode = await verifyInstall({ json: opts.json, probe: opts.probe });
      process.exit(exitCode);
    } catch (error) {
      process.stderr.write(`Verify failed: ${error.message}\n`);
      process.exit(1);
    }
  }
  if (command === "serve") {
    const opts = flags(rest);
    try {
      if (opts.wrap) {
        const { startProxy } = await import("../src/proxy.mjs");
        await startProxy({ workspace: opts.workspace });
      } else {
        const { startServer } = await import("../src/serve.mjs");
        await startServer({ workspace: opts.workspace });
      }
      // startServer / startProxy keeps the process alive on stdio
    } catch (error) {
      process.stderr.write(`Server failed: ${error.message}\n`);
      process.exit(1);
    }
    return;
  }
  usage();
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`Unexpected error: ${error.stack || error.message}\n`);
  process.exit(1);
});
