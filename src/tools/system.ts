import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostArg, run, sh, shQuote } from "./common.js";

const SNAPSHOT = `
echo "== mem (MB)"; free -m | awk 'NR==2{print "used "$3" / "$2", available "$7} NR==3{print "swap used "$3" / "$2}'
echo "== disk /"; df -h / | awk 'NR==2{print "used "$3" / "$2" ("$5"), avail "$4}'
echo "== load"; uptime
echo "== listening tcp"
ss -tlnpH 2>/dev/null | awk '{p=$6; sub(/^users:\\(\\("/, "", p); sub(/".*/, "", p); print $4, p}' | sort -u`;

export function registerSystem(server: McpServer): void {
  server.registerTool(
    "sys_snapshot",
    {
      description: "Memory, root disk, load and listening TCP ports of a Linux host in one call.",
      inputSchema: { host: hostArg },
    },
    ({ host }) => run(host, sh(SNAPSHOT)),
  );

  server.registerTool(
    "service_status",
    {
      description: "systemd unit state (load/active/enabled) plus its recent journal lines.",
      inputSchema: {
        host: hostArg,
        unit: z.string().regex(/^[A-Za-z0-9@._:\\-]+$/).refine((u) => !u.startsWith("-")),
        lines: z.number().int().min(0).max(500).default(20).describe("Journal lines, 0 for none"),
        since: z.string().optional().describe('journalctl --since, e.g. "2 hours ago"'),
      },
    },
    ({ host, unit, lines, since }) => {
      const script = `u=${shQuote(unit)}
ls=$(systemctl show -p LoadState --value "$u" 2>&1)
echo "load: $ls"
[ "$ls" = not-found ] && exit 0
echo "active: $(systemctl is-active "$u")"
echo "enabled: $(systemctl is-enabled "$u" 2>&1)"
[ ${lines} -gt 0 ] || exit 0
J=journalctl; [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null && J="sudo -n journalctl"
echo "== journal"
$J -u "$u" -n ${lines}${since ? ` --since ${shQuote(since)}` : ""} --no-pager -o short-iso 2>&1`;
      return run(host, sh(script));
    },
  );
}
