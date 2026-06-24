#!/usr/bin/env node

import { startServer } from "@gomission/mcp/src/serve.mjs";

await startServer({ workspace: process.env.MISSION_WORKSPACE || "" });
