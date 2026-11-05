import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { compactJson, redact, text, truncate } from "../output.js";
import { maxCharsArg, type ToolFilter } from "./common.js";

const CF_BASE = "https://api.cloudflare.com";
const TIMEOUT_MS = 30_000;

/**
 * 令牌目录里的令牌名：不以 . 开头的普通文件的文件名，按名字排序，第一个是默认令牌。目录没设或读不了时
 * 返回空数组。
 */
export function tokenNames(dir: string | undefined): string[] {
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((f) => !f.startsWith(".") && statSync(join(dir, f)).isFile())
      .sort();
  } catch {
    return [];
  }
}

/** 读出名为 account 的令牌，不传就用默认令牌。组和其他用户对文件有任何权限时拒绝，600 或 400 才行。 */
export function readToken(dir: string | undefined, account?: string): string {
  const names = tokenNames(dir);
  if (!dir || names.length === 0) {
    throw new Error("没有 Cloudflare 令牌：请把环境变量 SSH_MCP_CF_TOKEN_DIR 设成令牌目录，每份令牌一个文件，文件名就是令牌名。");
  }
  const name = account ?? names[0];
  if (!names.includes(name)) throw new Error(`没有名为「${name}」的令牌，可用的有：${names.join(", ")}`);
  const file = join(dir, name);
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`令牌文件 ${file} 的权限是 ${mode.toString(8)}，别人也能读；请先 chmod 600。`);
  return readFileSync(file, "utf8").trim();
}

interface CfArgs {
  path: string;
  method: string;
  body?: string;
  account?: string;
  max_chars?: number;
}

interface CfResponse {
  status: number;
  ok: boolean;
  raw: string;
  json?: { success?: boolean; result?: unknown };
}

/**
 * 调一次 Cloudflare API。path 开头是 `zones/<域名>` 时，先按域名查出 zone_id 再替换进去。状态码不是 2xx
 * 或返回的 success 为 false 时报错。base 只在测试里换成本机的假服务器。
 */
export async function cfCall(
  a: CfArgs,
  env: { dir?: string; base?: string },
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const token = readToken(env.dir, a.account);
  if (a.body !== undefined) {
    try {
      JSON.parse(a.body);
    } catch {
      return text("body 要是合法的 JSON。", true);
    }
  }
  const request = async (method: string, path: string, body?: string): Promise<CfResponse> => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(`${env.base ?? CF_BASE}/client/v4/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const raw = await res.text();
    let json: CfResponse["json"];
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: res.ok && json?.success !== false, raw, json };
  };
  const format = (r: CfResponse) =>
    text(`http=${r.status}\n${truncate(redact(compactJson(r.raw)), a.max_chars)}`, !r.ok);

  let path = a.path.replace(/^\/+/, "");
  const zone = /^zones\/([^/?]+\.[^/?]+)(.*)$/.exec(path);
  if (zone) {
    const found = await request("GET", `zones?name=${encodeURIComponent(zone[1])}`);
    const list = found.ok && Array.isArray(found.json?.result) ? (found.json.result as { id?: string }[]) : [];
    if (!found.ok) return format(found);
    if (!list[0]?.id) return text(`找不到域名 ${zone[1]}：这份令牌看不到它，或它不在 Cloudflare 上。`, true);
    path = `zones/${list[0].id}${zone[2]}`;
  }
  return format(await request(a.method, path, a.body));
}

export function registerCloudflare(server: McpServer, on: ToolFilter): void {
  if (!on("cf_api")) return;
  const names = tokenNames(process.env.SSH_MCP_CF_TOKEN_DIR);
  server.registerTool(
    "cf_api",
    {
      description:
        "从本机调用 Cloudflare API v4，令牌由工具注入。path 相对 /client/v4/，如 \"zones\"、\"zones/<zone_id>/dns_records\"；" +
        'zone_id 可以直接写域名，如 "zones/example.com/dns_records"。' +
        (names.length ? `可用令牌：${names.join(", ")}，不传 account 时用 ${names[0]}。` : "还没有配置令牌，见 SSH_MCP_CF_TOKEN_DIR。"),
      inputSchema: {
        path: z.string().min(1),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        body: z.string().optional().describe("JSON 请求体"),
        account: z.string().optional().describe("用哪份令牌"),
        max_chars: maxCharsArg,
      },
    },
    (a, extra) => cfCall(a, { dir: process.env.SSH_MCP_CF_TOKEN_DIR }, extra.signal),
  );
}
