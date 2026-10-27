import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostArg, maxCharsArg, run, shQuote, timeoutArg } from "./common.js";

const containerArg = z.string().min(1).describe("Container name or id");

export function registerDocker(server: McpServer): void {
  server.registerTool(
    "docker_ps",
    {
      description: "List containers on a host as name, image, status (tab separated).",
      inputSchema: {
        host: hostArg,
        filter: z.string().optional().describe("Case-insensitive regex on the line"),
        all: z.boolean().default(true).describe("Include stopped containers"),
      },
    },
    ({ host, filter, all }) => {
      let cmd = `docker ps${all ? " -a" : ""} --format '{{.Names}}\t{{.Image}}\t{{.Status}}'`;
      if (filter) cmd += ` | { grep -Ei -- ${shQuote(filter)} || echo '(no match)'; }`;
      return run(host, cmd);
    },
  );

  server.registerTool(
    "docker_exec",
    {
      description:
        "Run cmd inside a container with `sh -c`; write it as you would inside the container, the tool does the quoting.",
      inputSchema: { host: hostArg, container: containerArg, cmd: z.string(), timeout: timeoutArg, max_chars: maxCharsArg },
    },
    ({ host, container, cmd, timeout, max_chars }) =>
      run(host, `docker exec ${shQuote(container)} sh -c ${shQuote(cmd)}`, {
        timeoutS: timeout,
        maxChars: max_chars,
        guard: cmd,
      }),
  );

  server.registerTool(
    "docker_logs",
    {
      description: "Tail a container's logs (stdout and stderr merged).",
      inputSchema: {
        host: hostArg,
        container: containerArg,
        tail: z.number().int().min(1).max(5000).default(100),
        since: z.string().optional().describe("e.g. 30m, 2h, 2026-10-26T10:00"),
        max_chars: maxCharsArg,
      },
    },
    ({ host, container, tail, since, max_chars }) =>
      run(
        host,
        `docker logs --tail ${tail}${since ? ` --since ${shQuote(since)}` : ""} ${shQuote(container)} 2>&1`,
        { maxChars: max_chars },
      ),
  );
}
