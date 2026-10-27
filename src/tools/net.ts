import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostArg, maxCharsArg, run, sh, shQuote } from "./common.js";

/**
 * Panel address comes from the x-ui settings table (webListen/webPort/webBasePath/webCertFile),
 * the token from /etc/x-ui-api-token; neither passes through this machine.
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

export function registerNet(server: McpServer): void {
  server.registerTool(
    "http_probe",
    {
      description: "From a host, fetch a URL (optionally via a proxy) and report HTTP code, time and the egress IP.",
      inputSchema: {
        host: hostArg,
        url: z.string().url(),
        proxy: z.string().optional().describe("curl -x value, e.g. http://127.0.0.1:10809 or socks5h://127.0.0.1:1080"),
        timeout: z.number().int().min(1).max(120).default(15),
        egress_ip: z.boolean().default(true).describe("Also look up the egress IP via api.ipify.org"),
      },
    },
    ({ host, url, proxy, timeout, egress_ip }) => {
      const via = proxy ? ` -x ${shQuote(proxy)}` : "";
      let script = `curl -sS -o /dev/null -w 'http=%{http_code} time=%{time_total}s remote=%{remote_ip}\\n' --max-time ${timeout}${via} ${shQuote(url)} 2>&1`;
      if (egress_ip) script += `\necho "egress_ip=$(curl -sS --max-time ${timeout}${via} https://api.ipify.org 2>&1)"`;
      return run(host, sh(script), { timeoutS: timeout * 2 + 10 });
    },
  );

  server.registerTool(
    "xui_api",
    {
      description:
        "Call the host's x-ui/3x-ui panel API with its Bearer token injected on the remote side (panel address read from x-ui.db). " +
        'path is relative to the panel base path, e.g. "panel/api/server/status", "panel/api/inbounds/list".',
      inputSchema: {
        host: hostArg,
        path: z.string().min(1),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
        body: z.string().optional().describe("JSON request body"),
        max_chars: maxCharsArg,
      },
    },
    ({ host, path, method, body, max_chars }) => {
      const data = body !== undefined ? ` -H 'Content-Type: application/json' --data-binary @-` : "";
      // Body goes to stdout untouched (so JSON gets compacted); a non-2xx code is reported on stderr.
      const script = `${XUI_BASE}
o=$(mktemp); trap 'rm -f "$o"' EXIT
code=$(curl -sS -k --max-time 20 -o "$o" -w '%{http_code}' -X ${method} -H "Authorization: Bearer $T"${data} "$U/"${shQuote(path.replace(/^\/+/, ""))})
cat "$o"
case "$code" in 2*) ;; *) echo "http=$code" >&2; exit 22;; esac`;
      return run(host, sh(script), { stdin: body, maxChars: max_chars });
    },
  );
}
