#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toolFilter } from "./tools/common.js";
import { registerExec } from "./tools/exec.js";
import { registerDocker } from "./tools/docker.js";
import { registerFiles } from "./tools/files.js";
import { registerJob } from "./tools/job.js";
import { registerNet } from "./tools/net.js";
import { registerSystem } from "./tools/system.js";

// 源码和构建产物都在包根目录的下一层，package.json 就在上一级
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = new McpServer({ name: "remote-ssh", version });
const on = toolFilter(process.env.SSH_MCP_TOOLS);
registerExec(server);
registerFiles(server, on);
registerJob(server, on);
registerDocker(server, on);
registerSystem(server, on);
registerNet(server, on);
await server.connect(new StdioServerTransport());
