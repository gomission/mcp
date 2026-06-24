import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "inherit"],
});

const messages = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gomission-verify", version: "0.1.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
];

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString("utf8");
});

for (const message of messages) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

setTimeout(() => {
  child.kill("SIGTERM");
  const lines = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const initialized = lines.some((line) => line.id === 1 && line.result?.serverInfo?.name === "gomission");
  const tools = lines.find((line) => line.id === 2)?.result?.tools || [];
  if (!initialized || !tools.some((tool) => tool.name === "request_approval")) {
    console.error(output || "No MCP response received.");
    process.exit(1);
  }
  console.log(`MCP verification passed with ${tools.length} tools.`);
}, 500);
