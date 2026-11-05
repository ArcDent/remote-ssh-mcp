import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { Readable, type Writable } from "node:stream";
import { z } from "zod";
import { assertHost } from "../hosts.js";
import { DEFAULT_MAX_CHARS, formatResult } from "../output.js";
import {
  clampTimeout, type Conn, connArgs, KILL_GRACE_S, MAX_TIMEOUT_S, probeHost, remoteTimeoutWrap, runSsh, shQuote,
  sudoWrap, type SshResult,
} from "../ssh.js";

// 这里不写字段说明：别名列表只在 exec 的说明里写一次。工具定义每轮都要发给模型，
// 这样能小一些。
export const hostArg = z.string();
export const timeoutArg = z
  .number().int().min(1).max(MAX_TIMEOUT_S).optional()
  .describe(`秒，默认 60，最多 ${MAX_TIMEOUT_S}`);
export const maxCharsArg = z
  .number().int().min(200).max(100000).optional()
  .describe(`每路输出的字符上限，默认 ${DEFAULT_MAX_CHARS}`);
/** 每个工具都有的 sudo、pswd 参数；说明只写在 exec 里。 */
export const sudoArgs = {
  sudo: z.boolean().optional(),
  pswd: z.string().refine((p) => !p.includes("\n"), "pswd 不能含换行").optional(),
};
/** 每个工具都有的 conn 参数；说明只写在 exec 里。 */
export const connArg = z
  .strictObject({
    hostname: z.string().regex(/^[\w.:-]+$/).refine((h) => !h.startsWith("-")).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    user: z.string().regex(/^[\w.-]+$/).refine((u) => !u.startsWith("-")).optional(),
    identity: z.string().min(1).optional(),
    jump: hostArg.optional(),
    password: z.string().refine((p) => !p.includes("\n"), "password 不能含换行").optional(),
  })
  .optional();

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** 决定注册哪些可选工具。exec 总是注册，不经过它判断。 */
export type ToolFilter = (name: string) => boolean;

/** 没设 SSH_MCP_TOOLS 时暴露的工具。 */
const DEFAULT_TOOLS = ["exec", "file_write", "pipe"];

/** 解析 SSH_MCP_TOOLS：要暴露的工具名，逗号或空格分隔；也可以写 "all"。 */
export function toolFilter(spec: string | undefined): ToolFilter {
  const s = spec?.trim();
  if (s === "all") return () => true;
  const names = new Set(s ? s.split(/[\s,]+/) : DEFAULT_TOOLS);
  return (name) => names.has(name);
}

interface RunOptions {
  timeoutS?: number;
  stdin?: string | Readable;
  /** 不收集标准输出，边读边写进这里（见 runSsh）。 */
  stdout?: Writable;
  maxChars?: number;
  /** 这次工具调用的请求上下文，里面有进度 token 和取消信号。 */
  extra?: ToolExtra;
  /** 代替 `extra` 里的取消信号。 */
  signal?: AbortSignal;
  /** 同一次调用里几次运行共用的进度回调；没传时用 `extra` 生成。 */
  onTick?: (elapsedS: number) => void;
  /**
   * 为 false 时 remoteCmd 是 PowerShell 命令行。主机端的 `timeout` 包装是 POSIX shell 写法，这时只在
   * 登录 shell 为 bash 的 MSYS 主机上加。
   */
  posix?: boolean;
  /** 经 sudo 以 root 身份运行（见 sudoWrap）。 */
  sudo?: boolean;
  /** sudo 要的密码，只能配 sudo。 */
  pswd?: string;
  /** 单次覆盖的连接参数（见 connArgs）。 */
  conn?: Conn;
}

/** sudo、pswd 的组合不对时返回原因。 */
export function sudoRefusal(o: { sudo?: boolean; pswd?: string; posix?: boolean }): string | null {
  if (o.pswd !== undefined && !o.sudo) return "pswd 要和 sudo: true 一起传。";
  if (o.sudo && o.posix === false) return "sudo 只支持 shell posix。";
  return null;
}

/**
 * 校验主机，经 ssh 运行并格式化结果。工具处理函数抛出的错误由 MCP SDK 转成 isError 结果，所以各
 * 工具都不用自己 try/catch。
 */
export async function run(host: string, remoteCmd: string, o: RunOptions = {}): Promise<CallToolResult> {
  assertHost(host);
  return formatResult(await runRaw(host, remoteCmd, o), o.maxChars);
}

/**
 * 经 ssh 运行，不格式化结果；只有主机未知、sudo 和 pswd 组合不对或 conn 不对时才抛错。主机有 GNU `timeout` 时，
 * 到点由主机自己停掉命令，本机 ssh 客户端再多给一段宽限，这样命令在主机上就结束了，不会在 ssh 被杀后
 * 继续运行。带 sudo 时 `timeout` 包在 sudo 里面，以 root 身份停掉命令。
 */
export async function runRaw(host: string, remoteCmd: string, o: RunOptions = {}): Promise<SshResult> {
  assertHost(host);
  const refusal = sudoRefusal(o);
  if (refusal) throw new Error(refusal);
  const conn = o.conn && connArgs(host, o.conn);
  const probe = await probeHost(host, conn);
  if (probe.failure) return probe.failure;
  const wrap = probe.timeout && (probe.msys || o.posix !== false);
  const timeoutS = clampTimeout(o.timeoutS);
  const timed = wrap ? remoteTimeoutWrap(remoteCmd, timeoutS, probe.msys) : remoteCmd;
  const text = typeof o.stdin === "string" ? o.stdin : undefined;
  const line = o.sudo ? sudoWrap(timed, text, o.pswd) : { cmd: timed, stdin: text };
  const r = await runSsh(host, line.cmd, {
    timeoutS,
    // 标准输入是流时，sudo 要的密码行放在流前面。
    stdin: typeof o.stdin === "object" ? prepend(line.stdin, o.stdin) : line.stdin,
    stdout: o.stdout,
    graceS: wrap ? KILL_GRACE_S + 5 : 0,
    signal: o.signal ?? o.extra?.signal,
    onTick: o.onTick ?? progressReporter(o.extra, timeoutS),
    conn,
  });
  // timeout(1) 发 TERM 后退出码是 124，发 KILL 后是 137；命令自己提前以这两个码退出不算超时。
  if (wrap && (r.code === 124 || r.code === 137) && (r.durationMs ?? 0) >= (timeoutS - 1) * 1000) {
    r.remoteTimedOut = true;
  }
  return r;
}

function prepend(head: string | undefined, src: Readable): Readable {
  if (!head) return src;
  return Readable.from(
    (async function* () {
      yield Buffer.from(head);
      yield* src;
    })(),
  );
}

/**
 * 命令运行期间发 MCP 进度通知，让有空闲超时的客户端（Cursor 是 120 秒）继续等。几次运行可以共用
 * 一个回调，只发比上次大的值。
 */
export function progressReporter(extra: ToolExtra | undefined, timeoutS: number) {
  const progressToken = extra?._meta?.progressToken;
  if (!extra || progressToken === undefined) return undefined;
  let last = 0;
  return (elapsedS: number) => {
    if (elapsedS <= last) return;
    last = elapsedS;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: elapsedS, total: timeoutS, message: `已运行 ${elapsedS}s，上限 ${timeoutS}s` },
      })
      .catch(() => {});
  };
}

/** 在 docker 容器里用 sh 运行 cmd；标准输入经 `docker exec -i` 传进容器。 */
export function inContainer(cmd: string, container?: string): string {
  return container ? `docker exec -i ${shQuote(container)} sh -c ${shQuote(cmd)}` : cmd;
}

export { sh, shQuote } from "../ssh.js";
