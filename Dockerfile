FROM node:22-alpine

WORKDIR /app
COPY . ./

# The package has no runtime dependencies. Run the stdio MCP server directly
# so registry inspectors can perform the standard initialize/tools/list flow.
CMD ["node", "bin/gomission-mcp.mjs", "serve"]
