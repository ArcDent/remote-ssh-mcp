import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkCommand, stdinIsScript } from "../guard.js";
import { assertHost, listHosts } from "../hosts.js";
import { JOB_ID, jobStartScript, jobStatusScript, newJobId } from "../jobs.js";
import { formatResult, formatSections, text } from "../output.js";
import { decodeClixml, hostShells, powershellCommand, SHELLS, type Shell } from "../shell.js";
import { clampTimeout, MAX_TIMEOUT_S, probeHost } from "../ssh.js";
import { hostArg, maxCharsArg, progressReporter, runRaw, sh, shQuote, timeoutArg, type ToolExtra } from "./common.js";

const MAX_CMDS = 10;
/** 每次调用的主机数 × 命令数上限；每段运行占一个 ssh 会话。 */
const MAX_RUNS = 20;
const LABEL = /^[\w.-]{1,32}$/;

const inputSchema = {
  host: z.union([hostArg, z.array(hostArg).min(1)]).describe("主机别名；传数组则在几台主机上同时执行"),
  cmd: z.string().optional(),
  cmds: z
    .record(z.string(), z.string()).optional()
    .describe(
      `最多 ${MAX_CMDS} 条互不依赖的命令同时执行，如 {"ps":"docker ps","disk":"df -h /"}；` +
        "结果按标签分段，各带退出码。有先后依赖的步骤写进同一条 cmd",
    ),
  stdin: z
    .string().optional()
    .describe('传给 cmd 的标准输入，脚本放这里就不用处理引号：cmd 写 "python3 -"、"sh -s" 或 "sqlite3 -readonly x.db"'),
  container: z.string().optional().describe("在这个 docker 容器里执行"),
  shell: z
    .enum(SHELLS).optional()
    .describe("默认 posix，主机列表里标了 shell 的主机用标的那个。PowerShell 脚本以 base64 编码传送，不受引号影响"),
  background: z.boolean().optional().describe("把 cmd 放到后台执行，立即返回任务号"),
  job: z
    .string().optional()
    .describe("background 返回的任务号：查看任务状态和日志末尾；同时传 timeout 时，最多等这么久让它结束"),
  timeout: timeoutArg,
  max_chars: maxCharsArg,
  redact: z.boolean().optional().describe("给输出里的密钥值打码（password=、token:、Bearer ...），默认 true"),
};

type ExecArgs = z.infer<z.ZodObject<typeof inputSchema>>;

export function registerExec(server: McpServer): void {
  const shells = hostShells(process.env.SSH_MCP_HOST_SHELLS);
  server.registerTool(
    "exec",
    {
      description:
        "在主机上执行命令，效果同 `ssh <host> '<cmd>'`；cmd 不用带最外层的引号。可用主机：" +
        listHosts().map((h) => (shells.has(h) ? `${h} (${shells.get(h)})` : h)).join(", "),
      inputSchema,
    },
    (args, extra) => exec(args, extra, shells),
  );
}

interface Run {
  host: string;
  label: string;
  cmd: string;
  shell: Shell;
}

async function exec(a: ExecArgs, extra: ToolExtra, shells: Map<string, Shell>): Promise<CallToolResult> {
  const hosts = typeof a.host === "string" ? [a.host] : [...new Set(a.host)];
  for (const h of hosts) assertHost(h);
  if (a.job !== undefined) return job(a, hosts, extra);
  if ((a.cmd === undefined) === (a.cmds === undefined)) return text("cmd、cmds、job 三者必须且只能传一个。", true);
  if (a.background && (a.cmds || hosts.length > 1)) return text("background 只能配一条 cmd、一台主机。", true);
  const entries: [string, string][] = a.cmds ? Object.entries(a.cmds) : [["", a.cmd!]];
  if (a.cmds) {
    if (entries.length < 1 || entries.length > MAX_CMDS) return text(`cmds 要有 1 到 ${MAX_CMDS} 条命令。`, true);
    const bad = entries.find(([label]) => !LABEL.test(label));
    if (bad) return text(`标签「${bad[0]}」不合法：只能用 1 到 32 个字母、数字或 _ . -`, true);
  }
  if (a.stdin !== undefined && a.cmds) return text("stdin 只能配 cmd，不能配 cmds。", true);
  if (a.container?.startsWith("-")) return text("container 要写容器名或 ID。", true);
  const runs: Run[] = hosts.flatMap((host) => {
    const shell = a.shell ?? shells.get(host) ?? "posix";
    return entries.map(([label, cmd]) => ({ host, label, cmd, shell }));
  });
  if (runs.length > MAX_RUNS) return text(`要跑的段数太多（${runs.length}）：主机数 × 命令数最多 ${MAX_RUNS}。`, true);
  if (a.container && runs.some((r) => r.shell !== "posix")) return text("container 只支持 shell posix。", true);
  for (const r of runs) {
    const ps = r.shell !== "posix";
    const refusal =
      checkCommand(r.cmd, undefined, ps) ??
      (a.stdin !== undefined && !ps && stdinIsScript(r.cmd) ? checkCommand(a.stdin) : null);
    if (refusal) return text(refusal, true);
  }
  const lines = runs.map((r) => remote(r, a.container));

  if (a.background) {
    if (runs[0].shell !== "posix") return text("background 只支持 shell posix。", true);
    const info = await probeHost(runs[0].host);
    if (info.failure) return formatResult(info.failure, a.max_chars, a.redact);
    const id = newJobId();
    return formatResult(
      await runRaw(runs[0].host, sh(jobStartScript(id, lines[0], info.msys)), { stdin: a.stdin, extra }),
      a.max_chars,
      a.redact,
    );
  }

  const timeoutS = clampTimeout(a.timeout);
  const onTick = progressReporter(extra, timeoutS);
  const results = await Promise.all(
    runs.map(async (r, i) => {
      const res = await runRaw(r.host, lines[i], { timeoutS, stdin: a.stdin, extra, onTick, posix: r.shell === "posix" });
      return r.shell === "posix" ? res : { ...res, stderr: decodeClixml(res.stderr) };
    }),
  );
  if (runs.length === 1) return formatResult(results[0], a.max_chars, a.redact);
  const name = (r: Run) => (hosts.length > 1 && a.cmds ? `${r.host}/${r.label}` : hosts.length > 1 ? r.host : r.label);
  return formatSections(runs.map((r, i) => ({ label: name(r), result: results[i] })), a.max_chars, a.redact);
}

/** 查后台任务状态；传了 timeout 就先等它结束，最多等这么久。 */
async function job(a: ExecArgs, hosts: string[], extra: ToolExtra): Promise<CallToolResult> {
  if (hosts.length > 1 || a.cmd !== undefined || a.cmds || a.stdin !== undefined || a.background || a.container) {
    return text("job 只能配一台主机，不能同时传 cmd、cmds、stdin、background 或 container。", true);
  }
  if (!JOB_ID.test(a.job!)) return text(`任务号「${a.job}」格式不对。`, true);
  // 状态脚本要在这次调用自身的超时之前结束。
  const waitS = Math.min(a.timeout ?? 0, MAX_TIMEOUT_S - 15);
  const timeoutS = clampTimeout(waitS + 15);
  const info = await probeHost(hosts[0]);
  if (info.failure) return formatResult(info.failure, a.max_chars, a.redact);
  const r = await runRaw(hosts[0], sh(jobStatusScript(a.job!, waitS, info.msys)), {
    timeoutS,
    extra,
    onTick: progressReporter(extra, timeoutS),
  });
  return formatResult(r, a.max_chars, a.redact);
}

/**
 * 生成交给主机登录 shell 的命令行。标准输入经 `docker exec -i` 传进容器。主机端的 timeout 包装是
 * POSIX shell 写法，PowerShell 命令只在 MSYS 主机上加（见 runRaw）。
 */
function remote(r: Run, container?: string): string {
  if (r.shell !== "posix") return powershellCommand(r.shell, r.cmd);
  return container ? `docker exec -i ${shQuote(container)} sh -c ${shQuote(r.cmd)}` : r.cmd;
}
