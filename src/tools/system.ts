import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostArg, run, sh, shQuote, type ToolFilter } from "./common.js";

// df 的列从末尾往前数，因为文件系统名可能带空格（"C:/Program Files/Git"）。
const SNAPSHOT = `
miss=; for c in free df uptime ss; do command -v $c >/dev/null 2>&1 || miss="$miss $c"; done
echo "== mem (MB)"; free -m | awk 'NR==2{print "used "$3" / "$2", available "$7} NR==3{print "swap used "$3" / "$2}'
echo "== disk /"; df -hP / | awk 'NR==2{print "used "$(NF-3)" / "$(NF-4)" ("$(NF-1)"), avail "$(NF-2)}'
echo "== load"; uptime
echo "== listening tcp"
ss -tlnpH 2>/dev/null | awk '{p=$6; sub(/^users:\\(\\("/, "", p); sub(/".*/, "", p); print $4, p}' | sort -u
[ -z "$miss" ] || { echo "not found on this host:$miss (sys_snapshot is for Linux hosts)" >&2; exit 127; }`;

export function registerSystem(server: McpServer, on: ToolFilter): void {
  if (on("sys_snapshot")) server.registerTool(
    "sys_snapshot",
    {
      description: "一次调用查出 Linux 主机的内存、根分区磁盘、负载和监听中的 TCP 端口。",
      inputSchema: { host: hostArg },
    },
    ({ host }, extra) => run(host, sh(SNAPSHOT), { extra }),
  );

  if (on("service_status")) server.registerTool(
    "service_status",
    {
      description: "查看 systemd 单元的状态（load/active/enabled）和最近的 journal 日志。",
      inputSchema: {
        host: hostArg,
        unit: z.string().regex(/^[A-Za-z0-9@._:\\-]+$/).refine((u) => !u.startsWith("-")),
        lines: z.number().int().min(0).max(500).default(20).describe("journal 日志行数，0 表示不看"),
        since: z.string().optional().describe('journalctl --since 的值，如 "2 hours ago"'),
      },
    },
    ({ host, unit, lines, since }, extra) => {
      const script = `u=${shQuote(unit)}
command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found (service_status needs a host with systemd)" >&2; exit 127; }
ls=$(systemctl show -p LoadState --value "$u" 2>&1)
echo "load: $ls"
[ "$ls" = not-found ] && exit 0
echo "active: $(systemctl is-active "$u")"
echo "enabled: $(systemctl is-enabled "$u" 2>&1)"
[ ${lines} -gt 0 ] || exit 0
J=journalctl; [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null && J="sudo -n journalctl"
echo "== journal"
$J -u "$u" -n ${lines}${since ? ` --since ${shQuote(since)}` : ""} --no-pager -o short-iso 2>&1`;
      return run(host, sh(script), { extra });
    },
  );
}
