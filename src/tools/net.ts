import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostArg, maxCharsArg, run, sh, shQuote, type ToolFilter } from "./common.js";

/**
 * 面板地址从 x-ui 的 settings 表读取（webListen/webPort/webBasePath/webCertFile），token 从
 * /etc/x-ui-api-token 读取，两者都不经过本机。
 */
const XUI_BASE = `
db=/etc/x-ui/x-ui.db
T=$(cat /etc/x-ui-api-token) || exit 1
q() { sqlite3 "$db" "select value from settings where key='$1'" 2>/dev/null; }
L=$(q webListen); P=$(q webPort); B=$(q webBasePath); C=$(q webCertFile)
case "$L" in ''|0.0.0.0|::) L=127.0.0.1;; *:*) L="[$L]";; esac
[ -n "$P" ] || P=2053
S=http; [ -n "$C" ] && S=https
B=\${B%/}; case "$B" in ''|/*) ;; *) B="/$B";; esac
U="$S://$L:$P$B"`;

export function registerNet(server: McpServer, on: ToolFilter): void {
  if (on("http_probe")) server.registerTool(
    "http_probe",
    {
      description: "从主机访问一个网址（可走代理），报告 HTTP 状态码、耗时和出口 IP。",
      inputSchema: {
        host: hostArg,
        url: z.string().url(),
        proxy: z.string().optional().describe("curl -x 的值，如 http://127.0.0.1:10809 或 socks5h://127.0.0.1:1080"),
        timeout: z.number().int().min(1).max(120).default(15),
        egress_ip: z.boolean().default(true).describe("同时经 api.ipify.org 查出口 IP"),
      },
    },
    ({ host, url, proxy, timeout, egress_ip }, extra) => {
      const via = proxy ? ` -x ${shQuote(proxy)}` : "";
      let script = `curl -sS -o /dev/null -w 'http=%{http_code} time=%{time_total}s remote=%{remote_ip}\\n' --max-time ${timeout}${via} ${shQuote(url)} 2>&1`;
      if (egress_ip) script += `\necho "egress_ip=$(curl -sS --max-time ${timeout}${via} https://api.ipify.org 2>&1)"`;
      return run(host, sh(script), { timeoutS: timeout * 2 + 10, extra });
    },
  );

  if (on("xui_api")) server.registerTool(
    "xui_api",
    {
      description:
        "调用主机上 x-ui/3x-ui 面板的接口，Bearer token 在远端注入，面板地址从 x-ui.db 读取。" +
        'path 相对于面板根路径，如 "panel/api/server/status"、"panel/api/inbounds/list"。',
      inputSchema: {
        host: hostArg,
        path: z.string().min(1),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
        body: z.string().optional().describe("JSON 请求体"),
        max_chars: maxCharsArg,
      },
    },
    ({ host, path, method, body, max_chars }, extra) => {
      const data = body !== undefined ? ` -H 'Content-Type: application/json' --data-binary @-` : "";
      // 响应体原样输出到标准输出，这样 JSON 会被压成一行；状态码不是 2xx 时报在标准错误里。
      const script = `${XUI_BASE}
o=$(mktemp); trap 'rm -f "$o"' EXIT
code=$(curl -sS -k --max-time 20 -o "$o" -w '%{http_code}' -X ${method} -H "Authorization: Bearer $T"${data} "$U/"${shQuote(path.replace(/^\/+/, ""))})
cat "$o"
case "$code" in 2*) ;; *) echo "http=$code" >&2; exit 22;; esac`;
      return run(host, sh(script), { stdin: body, maxChars: max_chars, extra });
    },
  );
}
