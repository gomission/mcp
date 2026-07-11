# Mission MCP

Mission MCP is the Trust Graduation gate for Claude and agentic work.

Claude can prepare real work. Mission decides what Claude is allowed to do by action class, evidence, approval, and receipt. The current npm release supports hard-wired proxy enforcement, local approval tools, and an explicit read-only remote surface.

## Links

- Mission for Claude: https://claude.gomission.io/
- Remote MCP endpoint: https://claude.gomission.io/mcp/
- npm package: https://www.npmjs.com/package/@gomission/mcp
- MCP Registry: https://registry.modelcontextprotocol.io/v0.1/servers/io.github.gomission/mcp/versions/latest

## Install

```bash
# Auto-select --wrap when consequential MCP servers exist, otherwise --local.
npx -y @gomission/mcp install-claude

# Or choose the boundary explicitly.
npx -y @gomission/mcp install-claude --wrap
npx -y @gomission/mcp install-claude --local
npx -y @gomission/mcp install-claude --remote  # read-only; no enforcement

npx -y @gomission/mcp verify
```

`--wrap` intercepts configured MCP tool calls and blocks consequential or uncertain calls with an approval ceremony. It fails closed when a wrapped child is unavailable. `--local` exposes Mission's approval tools with persistent local receipts. `--remote` exposes Mission state but does not gate other MCP servers.

## Trust Graduation

Trust Graduation is the model-agnostic protocol under Mission. Authority is earned per action class, never globally, and external effects remain bounded by policy and principal approval.

```bash
npm install @trust-graduation/core
```

- Protocol: https://trustgraduation.org/
- Reference package: https://www.npmjs.com/package/@trust-graduation/core
- Mission implementation profile: https://github.com/RonenTanchum/trust-graduation/blob/main/docs/mission-reference-profile.md

## Status

This repository is the public landing for the official MCP Registry entry. The maintained implementation ships in the npm package linked above. Current package release: `@gomission/mcp@0.2.1`.
