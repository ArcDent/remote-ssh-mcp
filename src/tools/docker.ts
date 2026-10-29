import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostArg, maxCharsArg, run, shQuote, timeoutArg, type ToolFilter } from "./common.js";

const containerArg = z.string().min(1).describe("容器名或 ID");

export function registerDocker(server: McpServer, on: ToolFilter): void {
  if (on("docker_ps")) server.registerTool(
    "docker_ps",
    {
      description: "列出主机上的容器，每行是名称、镜像、状态，以制表符分隔。",
      inputSchema: {
        host: hostArg,
        filter: z.string().optional().describe("按行匹配的正则，不区分大小写"),
        all: z.boolean().default(true).describe("包括已停止的容器"),
      },
    },
    ({ host, filter, all }, extra) => {
      let cmd = `docker ps${all ? " -a" : ""} --format '{{.Names}}\t{{.Image}}\t{{.Status}}'`;
      if (filter) cmd += ` | { grep -Ei -- ${shQuote(filter)} || echo '(no match)'; }`;
      return run(host, cmd, { extra });
    },
  );

  if (on("docker_exec")) server.registerTool(
    "docker_exec",
    {
      description:
        "用 `sh -c` 在容器里执行 cmd；按在容器里的写法写，引号由工具处理。",
      inputSchema: { host: hostArg, container: containerArg, cmd: z.string(), timeout: timeoutArg, max_chars: maxCharsArg },
    },
    ({ host, container, cmd, timeout, max_chars }, extra) =>
      run(host, `docker exec ${shQuote(container)} sh -c ${shQuote(cmd)}`, {
        timeoutS: timeout,
        maxChars: max_chars,
        guard: cmd,
        extra,
      }),
  );

  if (on("docker_logs")) server.registerTool(
    "docker_logs",
    {
      description: "查看容器日志的最后几行，标准输出和标准错误合在一起。",
      inputSchema: {
        host: hostArg,
        container: containerArg,
        tail: z.number().int().min(1).max(5000).default(100),
        since: z.string().optional().describe("如 30m、2h、2026-10-26T10:00"),
        max_chars: maxCharsArg,
      },
    },
    ({ host, container, tail, since, max_chars }, extra) =>
      run(
        host,
        `docker logs --tail ${tail}${since ? ` --since ${shQuote(since)}` : ""} ${shQuote(container)} 2>&1`,
        { maxChars: max_chars, extra },
      ),
  );
}
