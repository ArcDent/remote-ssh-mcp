import { createReadStream, readFileSync, statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkCommand, stdinIsScript } from "../guard.js";
import { assertHost } from "../hosts.js";
import { formatResult, formatSections, text, withHeader } from "../output.js";
import { clampTimeout, connArgs, localFile, probeHost, type SshResult, Tap } from "../ssh.js";
import {
  connArg, hostArg, maxCharsArg, progressReporter, runRaw, sudoArgs, sudoRefusal, timeoutArg, type ToolExtra,
  type ToolFilter,
} from "./common.js";

/** 去处从标准输入读脚本时，本机来源文件最多多少字节；脚本要先读进来过危险命令检查。 */
const MAX_SCRIPT_BYTES = 1024 * 1024;

const endArg = { host: hostArg, cmd: z.string(), ...sudoArgs, conn: connArg };
const inputSchema = {
  from: z
    .union([z.strictObject(endArg), z.strictObject({ file: z.string().min(1) })])
    .describe("来源：{host, cmd} 取这条命令的标准输出；或 {file} 读本机文件"),
  to: z.strictObject(endArg).describe("去处：{host, cmd}，数据作为这条命令的标准输入"),
  timeout: timeoutArg,
  max_chars: maxCharsArg,
  redact: z.boolean().optional(),
};

type PipeArgs = z.infer<z.ZodObject<typeof inputSchema>>;

export function registerPipe(server: McpServer, on: ToolFilter): void {
  if (on("pipe")) server.registerTool(
    "pipe",
    {
      description:
        "把来源的数据直接接到主机上命令的标准输入，效果同 `ssh A '<cmd>' | ssh B '<cmd>'`，数据只经过本机内存、不落盘。" +
        '如 from {"host":"a","cmd":"tar -C /etc -cf - nginx"}、to {"host":"b","cmd":"mkdir -p /backup/etc && tar -C /backup/etc -xf -"}。' +
        "两端各自可带 sudo、pswd、conn，用法同 exec。返回两端的退出码、传输的字节数和 sha256。",
      inputSchema,
    },
    (a, extra) => pipe(a, extra),
  );
}

async function pipe(a: PipeArgs, extra: ToolExtra): Promise<CallToolResult> {
  const from = "host" in a.from ? a.from : undefined;
  const file = "file" in a.from ? localFile(a.from.file) : undefined;
  if (file === null) return text(`from.file 要是本机上的普通文件：${"file" in a.from ? a.from.file : ""}`, true);
  const ends = from ? [from, a.to] : [a.to];
  for (const e of ends) {
    assertHost(e.host);
    const refusal = sudoRefusal(e) ?? checkCommand(e.cmd);
    if (refusal) return text(refusal, true);
  }
  if (stdinIsScript(a.to.cmd)) {
    if (!file) return text("to.cmd 从标准输入读脚本时，来源只能是本机文件，这样才能先检查脚本里的命令。", true);
    if (statSync(file).size > MAX_SCRIPT_BYTES) return text("to.cmd 从标准输入读脚本时，脚本不能超过 1 MB。", true);
    const refusal = checkCommand(readFileSync(file, "utf8"));
    if (refusal) return text(refusal, true);
  }
  // 两端都先连上再开始传：来源连不上时，去处会收到空的输入，`cat > 文件` 这类命令就把文件清空了。
  for (const e of ends) {
    const probe = await probeHost(e.host, e.conn && connArgs(e.host, e.conn));
    if (probe.failure) return formatResult(probe.failure, a.max_chars, a.redact);
  }

  const timeoutS = clampTimeout(a.timeout);
  const onTick = progressReporter(extra, timeoutS);
  const tap = new Tap();
  // 去处先结束时停掉来源，免得来源的输出没人读，一直等到超时。
  const stopFrom = new AbortController();
  const signal = extra.signal ? AbortSignal.any([extra.signal, stopFrom.signal]) : stopFrom.signal;
  let fromDone = false;
  const source = (
    from
      ? runRaw(from.host, from.cmd, {
          timeoutS, stdout: tap, extra, signal, onTick, sudo: from.sudo, pswd: from.pswd, conn: from.conn,
        })
      : readLocal(file!, tap, timeoutS, signal)
  ).then((r) => {
    fromDone = true;
    if (!tap.writableEnded) tap.end();
    return r;
  });
  const sink = runRaw(a.to.host, a.to.cmd, {
    timeoutS, stdin: tap, extra, onTick, sudo: a.to.sudo, pswd: a.to.pswd, conn: a.to.conn,
  }).then((r) => {
    if (!fromDone) stopFrom.abort();
    return r;
  });
  let [src, dst] = await Promise.all([source, sink]);
  if (src.cancelled && !extra.signal?.aborted) {
    src = { ...src, cancelled: false, stderr: `${src.stderr}去处先结束了，来源被停掉\n` };
  }

  const res = formatSections(
    [
      { label: `from ${from ? from.host : (a.from as { file: string }).file}`, result: src },
      { label: `to ${a.to.host}`, result: dst },
    ],
    a.max_chars,
    a.redact,
  );
  return withHeader(`传输 ${tap.bytes} 字节，sha256=${tap.sha256()}`, res);
}

/** 把本机文件写进 tap；结果按 SshResult 的样子返回，好和去处的结果一起格式化。 */
function readLocal(file: string, tap: Tap, timeoutS: number, signal: AbortSignal): Promise<SshResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const rs = createReadStream(file);
    const done = (code: number, stderr = "") => {
      signal.removeEventListener("abort", stop);
      resolve({ code, stdout: "", stderr, timedOut: false, timeoutS, durationMs: Date.now() - started });
    };
    const stop = () => {
      rs.destroy();
      done(1, "传输中途停止，文件没读完\n");
    };
    signal.addEventListener("abort", stop, { once: true });
    rs.on("error", (e) => done(1, `${e.message}\n`));
    rs.on("end", () => done(0));
    rs.pipe(tap);
  });
}
