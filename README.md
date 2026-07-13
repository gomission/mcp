# @gomission/mcp

> Claude can do more for you once Mission decides what it's allowed to do.

Mission is the permission layer for AI work. This package adds Mission to Claude Desktop as an MCP server. When Claude tries to do something consequential — send email, post publicly, schedule a meeting, spend money, modify an external record — Mission holds the action until you approve. Every action leaves a receipt.

This is the canonical demonstration of **Trust Graduation**: agents earn permission to do real work, action class by action class, through evidence and approval. Capability without permission is not yet trusted work.

## One-command install (Claude Desktop)

```bash
# Auto-recommend the right mode based on your existing Claude Desktop
# config. If you already have other MCP servers configured (gmail, slack,
# notion, …), this picks --wrap so each of them is gated. Otherwise it
# picks --local. The remote read-only path is never auto-selected.
npx -y @gomission/mcp install-claude
```

Restart Claude Desktop. What happens next depends on which mode was picked
(printed at install time).

### The three modes — pick the right gate for your setup

| Mode | What Mission does | Need to paste a system prompt? |
|---|---|---|
| `--wrap` | Intercepts every tool call from your other MCP servers (Gmail, Slack, …). Classifies. Blocks consequential calls with an approval ceremony. **Hard-wired.** | No |
| `--local` | Exposes Mission's own approval tools. Claude must be told to call them before consequential actions. **Soft-wired** — depends on Claude following the instruction. | Yes |
| `--remote` | Adds Mission as a read-only MCP server. **Does not gate anything.** Useful only for browsing receipts or Mission state. | No (but no gating either) |

If you have other MCP servers configured, `--wrap` is the only mode that
actually gates them. The bare `install-claude` command auto-detects this
and picks wrap. Pass `--local` or `--remote` explicitly to override.

```bash
# Pick a specific mode:
npx -y @gomission/mcp install-claude --wrap     # recommended when you have other MCP servers
npx -y @gomission/mcp install-claude --local    # approval ceremony for Mission's own tools
npx -y @gomission/mcp install-claude --remote   # read-only Mission state, no gating
```

## Verify the install

```bash
npx -y @gomission/mcp verify
```

Reads Claude Desktop's config, classifies the `gomission` entry mode (remote
bridge / local stub / local proxy / not installed / broken), and probes the
live MCP endpoint with a real `initialize` + `tools/list` round-trip. Confirms
the four Trust Graduation ceremony primitives (`mission_status`,
`request_approval`, `log_action`, `get_receipt`) are exposed. In wrap mode,
also lists the children that will be wrapped and any `MISSION_DONT_WRAP`
opt-outs in effect.

Exit codes: 0 = healthy, 2 = not installed, 3 = misconfigured, 4 = probe failed.

Add `--json` for machine-readable output, `--no-probe` to skip the round-trip.

### Alternative: Custom Connectors UI on claude.ai

If you use claude.ai (the web app) instead of Claude Desktop, add Mission via the
Custom Connectors UI:

1. claude.ai → Settings → Connectors → Add custom connector
2. URL: `https://claude.gomission.io/mcp/`
3. Complete OAuth.

This is the only supported remote-MCP path on claude.ai. The `npx` install above
targets Claude Desktop specifically.

### Flags

- no mode flag — inspect the existing Claude Desktop config and choose `--wrap` when consequential MCP servers are present, otherwise `--local`.
- `--wrap` — use the local Mission proxy; wrap other MCP servers and gate each call.
- `--local` — use a local stdio MCP server with the approval ceremony.
- `--remote` — use the hosted read-only Mission MCP. This is visibility, not enforcement.
- `--token <bearer>` — bearer token for the remote MCP (optional).
- `--remote-url <url>` — override the remote MCP URL.
- `--workspace <path>` — local mode: bridge receipts to an existing Mission workspace.
- `--dry-run` — print the planned config change without writing it.
- `--force` — write the config even if Claude Desktop is not yet installed.

### Wrap mode

Wrap mode is for users who already have other MCP servers configured in Claude Desktop (Gmail, Slack, Notion, GitHub, Stripe, calendar adapters, etc.) and want every consequential call gated without rewriting their workflow.

How it works:

1. The proxy reads Claude Desktop's `mcpServers` map and selects entries whose names or commands look consequential (verbs like `send`, `post`, `email`, `calendar`, `payment`; servers like `gmail`, `slack`, `stripe`).
2. The proxy spawns each selected entry as a stdio child and aggregates their tools under prefixed names: `gmail__send_email`, `slack__post_message`, etc.
3. On every `tools/call`, the proxy classifies the call into a canonical Trust Graduation action class (`email.send.external`, `payment.initiate`, `read.context`, …). Risk classes `high` and `critical`, or any classification below confidence 0.6, block the call with an approval ceremony and write a pending-approval receipt. Safer calls forward to the child and produce a `forwarded` receipt.
4. If the child is unreachable or errors mid-call, the proxy **blocks** rather than passing through. This is the load-bearing safety invariant: an unreachable wrapped server cannot leak an external call.

Opt out per-server (e.g., your internal-only Notion):

```jsonc
// claude_desktop_config.json
"gomission": {
  "command": "npx",
  "args": ["-y", "@gomission/mcp", "serve", "--wrap"],
  "env": { "MISSION_DONT_WRAP": "notion,my-internal-server" }
}
```

The proxy's own entries (`gomission`, `mission`) are always skipped — the gate never wraps itself.

When to pick which mode:

| You want… | Use |
|---|---|
| To actually gate the Gmail/Slack/etc. servers you already have | `--wrap` (recommended; auto-selected when other MCP servers are configured) |
| Mission's own approval ceremony with persistent receipts | `--local` |
| Visibility into Mission state from Claude with no enforcement | `--remote` |

### Coexistence with the full Mission product

If you already use Mission (the full operating workspace) and have run its own
`mission mcp install-claude`, that command writes the `mission` entry in your
Claude Desktop config. This package writes a distinct `gomission` entry, so both
can coexist:

- `mcpServers.mission` — full local Mission install (operating workspace).
- `mcpServers.gomission` — Trust Graduation gate (local proxy or stub), or an explicitly selected remote read-only surface.

## What Claude can and cannot do once installed

Claude can:

- Read your Mission workspace state, open loops, drafts, voice profile, receipts.
- Prepare drafts, summaries, plans, research.
- Log safe internal actions and produce receipts.
- Request approval for consequential actions and surface the gate visibly in conversation.

Claude cannot, without your approval:

- Send email, DMs, or posts.
- Schedule meetings or change calendar invites.
- Spend money.
- Publish artifacts externally.
- Modify external records.
- Change Mission's trust policy.

The list of gated action classes is visible at any time. Ask Claude: `mission status`.

## Verify install

```bash
npx -y @gomission/mcp install-claude --dry-run
```

Prints the planned config without writing anything.

## Uninstall

Open Claude Desktop's config file (path printed by the install command) and remove the `mission` entry under `mcpServers`. Restart Claude.

## Learn more

- Landing: https://claude.gomission.io
- Trust Graduation protocol: see the landing page for the open specification.
- Mission product: https://gomission.io

## License

Copyright (c) 2026 Phenomena Labs Ltd. Proprietary and confidential. See `LICENSE`.
