import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkCommand, stdinIsScript } from "../guard.js";
import { assertHost } from "../hosts.js";
import {
  formatJobList, JOB_ID, jobKillScript, jobListScript, jobStartScript, jobStatusScript, newJobId,
} from "../jobs.js";
import { formatResult, text } from "../output.js";
import { clampTimeout, KILL_GRACE_S, MAX_TIMEOUT_S, probeHost, type SshResult } from "../ssh.js";
import {
  hostArg, inContainer, maxCharsArg, progressReporter, runRaw, sh, sudoArgs, sudoRefusal, type ToolExtra, type ToolFilter,
} from "./common.js";

const inputSchema = {
  action: z.enum(["start", "status", "list", "kill"]),
  host: hostArg,
  cmd: z.string().optional(),
  stdin: z.string().optional(),
  container: z.string().optional(),
  id: z.string().optional().describe("start 返回的任务号"),
  timeout: z.number().int().min(1).max(MAX_TIMEOUT_S).optional().describe("status 时最多等这么多秒让任务结束"),
  max_chars: maxCharsArg,
  redact: z.boolean().optional(),
  ...sudoArgs,
};

type JobArgs = z.infer<z.ZodObject<typeof inputSchema>>;

export function registerJob(server: McpServer, on: ToolFilter): void {
  if (on("job")) server.registerTool(
    "job",
    {
      description:
        "后台任务。start：在主机上脱离 ssh 运行 cmd，立即返回任务号，断线后照常运行；status：看状态和日志末尾；" +
        "list：列出主机上的任务；kill：停掉任务和它的子进程。host、cmd、stdin、container、redact、sudo、pswd 同 exec；" +
        "带 sudo 启动的任务，status、list、kill 也要带 sudo。",
      inputSchema,
    },
    (a, extra) => job(a, extra),
  );
}

async function job(a: JobArgs, extra: ToolExtra): Promise<CallToolResult> {
  assertHost(a.host);
  const badSudo = sudoRefusal(a);
  if (badSudo) return text(badSudo, true);
  if (a.action === "start") {
    if (a.cmd === undefined) return text("action start 要传 cmd。", true);
    if (a.container?.startsWith("-")) return text("container 要写容器名或 ID。", true);
    const refusal =
      checkCommand(a.cmd) ?? (a.stdin !== undefined && stdinIsScript(a.cmd) ? checkCommand(a.stdin) : null);
    if (refusal) return text(refusal, true);
  } else if (a.cmd !== undefined || a.stdin !== undefined || a.container !== undefined) {
    return text("cmd、stdin、container 只能配 action start。", true);
  }
  if ((a.action === "status" || a.action === "kill") && !JOB_ID.test(a.id ?? "")) {
    return text(a.id === undefined ? `action ${a.action} 要传 id。` : `任务号「${a.id}」格式不对。`, true);
  }
  const info = await probeHost(a.host);
  if (info.failure) return formatResult(info.failure, a.max_chars, a.redact);

  const asRoot = { sudo: a.sudo, pswd: a.pswd };
  let r: SshResult;
  if (a.action === "start") {
    const script = jobStartScript(newJobId(), inContainer(a.cmd!, a.container), info.msys);
    r = await runRaw(a.host, sh(script), { stdin: a.stdin, extra, ...asRoot });
  } else if (a.action === "status") {
    // 状态脚本要在这次调用自身的超时之前结束。
    const waitS = Math.min(a.timeout ?? 0, MAX_TIMEOUT_S - 15);
    const timeoutS = clampTimeout(waitS + 15);
    r = await runRaw(a.host, sh(jobStatusScript(a.id!, waitS, info.msys)), {
      timeoutS,
      extra,
      onTick: progressReporter(extra, timeoutS),
      ...asRoot,
    });
  } else if (a.action === "kill") {
    r = await runRaw(a.host, sh(jobKillScript(a.id!, info.msys)), { timeoutS: KILL_GRACE_S + 30, extra, ...asRoot });
  } else {
    r = await runRaw(a.host, sh(jobListScript(info.msys)), { extra, ...asRoot });
    if (r.code === 0) r = { ...r, stdout: formatJobList(r.stdout) };
  }
  return formatResult(r, a.max_chars, a.redact);
}
