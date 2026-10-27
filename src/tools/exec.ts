import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listHosts } from "../hosts.js";
import { hostArg, maxCharsArg, run, timeoutArg } from "./common.js";

export function registerExec(server: McpServer): void {
  server.registerTool(
    "exec",
    {
      description:
        "Run a shell command on a host, same as `ssh <host> '<cmd>'`; write cmd without the outer quotes. " +
        "Prefer a dedicated tool when one fits. Hosts: " +
        listHosts().join(", "),
      inputSchema: { host: hostArg, cmd: z.string(), timeout: timeoutArg, max_chars: maxCharsArg },
    },
    ({ host, cmd, timeout, max_chars }) => run(host, cmd, { timeoutS: timeout, maxChars: max_chars, guard: cmd }),
  );
}
