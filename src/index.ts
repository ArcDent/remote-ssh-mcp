#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerExec } from "./tools/exec.js";
import { registerDocker } from "./tools/docker.js";
import { registerFiles } from "./tools/files.js";
import { registerNet } from "./tools/net.js";
import { registerSystem } from "./tools/system.js";

const server = new McpServer({ name: "remote-ssh", version: "0.1.0" });
registerExec(server);
registerFiles(server);
registerDocker(server);
registerSystem(server);
registerNet(server);
await server.connect(new StdioServerTransport());
