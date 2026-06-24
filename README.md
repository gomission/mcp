# Mission MCP

Mission MCP is the official runnable MCP server wrapper for Mission's Trust Graduation protocol: approval packets, action-class gates, and receipt-backed boundaries before agents take consequential actions.

This repository exists so MCP directories, evaluators, and local clients can start and inspect the server directly. The implementation delegates to the published `@gomission/mcp` package.

## What It Exposes

The server speaks MCP over newline-delimited JSON-RPC on stdio and exposes Mission approval and receipt primitives for governed agent execution.

Typical tool categories:

- request or prepare approval before external action
- record receipts after approved action
- inspect Trust Graduation policy and action-class state
- prepare safe, reviewable work instead of executing blindly

## Install

```bash
npm install
npm run verify
```

Or run with `npx`:

```bash
npx -y @gomission/mcp
```

## Docker

```bash
docker build -t gomission-mcp .
docker run -i gomission-mcp
```

## Links

- Mission: https://gomission.io
- Trust Graduation: https://trustgraduation.org
- Mission for Claude: https://claude.gomission.io/
- Remote MCP endpoint: https://claude.gomission.io/mcp/
- npm package: https://www.npmjs.com/package/@gomission/mcp
- MCP Registry: https://registry.modelcontextprotocol.io/v0.1/servers/io.github.gomission/mcp/versions/latest

## License

MIT for this wrapper repository. The published Mission runtime package declares its own package license.
