import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatResult, text, withHeader } from "../output.js";
import { closeMaster } from "../ssh.js";
import { connArg, hostArg, progressReporter, runRaw, sh, sudoArgs, type ToolExtra, type ToolFilter } from "./common.js";

/** 等主机回来时每隔多久试一次。 */
const POLL_MS = 5000;
const MAX_WAIT_S = 900;
const READ_BOOT_ID = "cat /proc/sys/kernel/random/boot_id";

/**
 * 隔 delayS 秒后在后台重启，命令立即返回；输出全部丢掉、忽略挂断信号，ssh 会话关掉后照样执行。
 * 没有 systemctl 时用 reboot。
 */
export function rebootLater(delayS: number): string {
  return `nohup sh -c 'sleep ${delayS}; systemctl reboot 2>/dev/null || reboot' >/dev/null 2>&1 </dev/null &`;
}

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: Clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/**
 * 每隔 POLL_MS 用 read 读一次 boot_id，读到和 oldId 不同的值就算主机回来了。到 waitS 还没变时返回原因：
 * 最后一次读到的还是旧值，说明主机可能根本没重启；读不到，说明还没回来。
 */
export async function waitForBoot(
  read: () => Promise<string | null>,
  oldId: string,
  waitS: number,
  onTick?: (elapsedS: number) => void,
  clock: Clock = realClock,
): Promise<{ back: true; downS: number } | { back: false; error: string }> {
  const start = clock.now();
  for (;;) {
    const id = await read();
    const downS = Math.round((clock.now() - start) / 1000);
    onTick?.(downS);
    if (id && id !== oldId) return { back: true, downS };
    if (clock.now() - start >= waitS * 1000) {
      const error =
        id === oldId
          ? `等了 ${waitS} 秒，boot_id 一直没变，重启命令可能没生效。`
          : `等了 ${waitS} 秒主机还没回来，可能还在启动，稍后用 exec 再看看。`;
      return { back: false, error };
    }
    await clock.sleep(POLL_MS);
  }
}

const inputSchema = {
  host: hostArg,
  wait: z.number().int().min(30).max(MAX_WAIT_S).default(300).describe(`最多等多少秒，默认 300，最多 ${MAX_WAIT_S}`),
  ...sudoArgs,
  conn: connArg,
};

type RebootArgs = z.infer<z.ZodObject<typeof inputSchema>>;

export function registerReboot(server: McpServer, on: ToolFilter): void {
  if (on("reboot")) server.registerTool(
    "reboot",
    {
      description:
        "重启 Linux 主机并等它回来：重启前后各读一次 boot_id，变了才算重启过；返回停机时长、uptime 和失败的 systemd 服务。" +
        "host、sudo、pswd、conn 同 exec，非 root 登录时要带 sudo。",
      inputSchema,
    },
    (a, extra) => reboot(a, extra),
  );
}

async function reboot(a: RebootArgs, extra: ToolExtra): Promise<CallToolResult> {
  const opts = { sudo: a.sudo, pswd: a.pswd, conn: a.conn, extra };
  // 读 boot_id、确认是 root、在后台发出重启，一次 ssh 做完。
  const start = await runRaw(
    a.host,
    sh(`b=$(${READ_BOOT_ID}) || { echo "cannot read boot_id (reboot needs a Linux host)" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "not root: pass sudo" >&2; exit 1; }
${rebootLater(2)}
echo "$b"`),
    opts,
  );
  const oldId = start.stdout.trim();
  if (start.code !== 0 || !oldId) return formatResult(start);
  closeMaster(a.host);

  // 用新连接试，不走复用连接：主机重启后旧连接已经断了。
  const read = async () => {
    if (extra.signal.aborted) throw new Error("客户端取消了调用，主机可能正在重启。");
    const r = await runRaw(a.host, READ_BOOT_ID, { timeoutS: 15, conn: a.conn ?? {}, extra });
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const w = await waitForBoot(read, oldId, a.wait, progressReporter(extra, a.wait));
  if (!w.back) return text(w.error, true);
  const after = await runRaw(
    a.host,
    sh(`uptime
f=$(systemctl --failed --no-legend --plain 2>/dev/null) || f="(systemctl not found)"
echo "== failed units"
echo "\${f:-none}"`),
    { conn: a.conn, extra },
  );
  return withHeader(`重启完成：约 ${w.downS} 秒后回来，boot_id 已变。`, formatResult(after));
}
