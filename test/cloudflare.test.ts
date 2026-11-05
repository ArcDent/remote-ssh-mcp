import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cfCall, readToken, tokenNames } from "../src/tools/cloudflare.js";

/** 建一个令牌目录，每项是 [令牌名, 令牌, 权限]。 */
function tokenDir(files: [string, string, number][]): string {
  const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-cf-"));
  for (const [name, token, mode] of files) {
    writeFileSync(join(dir, name), `${token}\n`);
    chmodSync(join(dir, name), mode);
  }
  return dir;
}

const textOf = (r: CallToolResult) => (r.content[0]?.type === "text" ? r.content[0].text : "");

describe("令牌目录", () => {
  const dir = tokenDir([["v", "tok-v", 0o644], ["own", "tok-own", 0o600], [".DS_Store", "x", 0o644]]);

  it("按名字排序列出令牌，跳过隐藏文件", () => {
    expect(tokenNames(dir)).toEqual(["own", "v"]);
  });

  it("权限不是 600 的拒绝，并提示 chmod 600", () => {
    expect(readToken(dir, "own")).toBe("tok-own");
    expect(() => readToken(dir, "v")).toThrow(/权限是 644.*chmod 600/);
  });

  it("目录没设或为空时报错，写明要设 SSH_MCP_CF_TOKEN_DIR", () => {
    expect(() => readToken(undefined)).toThrow(/SSH_MCP_CF_TOKEN_DIR/);
    expect(() => readToken(tokenDir([]))).toThrow(/SSH_MCP_CF_TOKEN_DIR/);
  });
});

describe("cfCall", () => {
  // 本机假服务器：记下每个请求，按路径返回预设的响应。
  const seen: { method?: string; url?: string; auth?: string; type?: string; body: string }[] = [];
  let routes: Record<string, [number, unknown]> = {};
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body });
    const [status, json] = routes[req.url ?? ""] ?? [404, { success: false, errors: [{ message: "no route" }] }];
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });
  const dir = tokenDir([["b", "tok-b", 0o600], ["a", "tok-a", 0o600]]);
  const call = (a: { path: string; method?: string; body?: string; account?: string; max_chars?: number }) =>
    cfCall({ method: "GET", ...a }, { dir, base });

  it("令牌放进 Authorization 头，路径拼对；不传 account 时用排序后的第一份", async () => {
    seen.length = 0;
    routes = { "/client/v4/zones?per_page=1": [200, { success: true, result: [] }] };
    const r = await call({ path: "/zones?per_page=1" });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe('http=200\n{"success":true,"result":[]}\n');
    await call({ path: "zones?per_page=1", account: "b" });
    expect(seen.map((s) => [s.method, s.url, s.auth])).toEqual([
      ["GET", "/client/v4/zones?per_page=1", "Bearer tok-a"],
      ["GET", "/client/v4/zones?per_page=1", "Bearer tok-b"],
    ]);
  });

  it("请求体原样发出，带 JSON 类型；body 不是 JSON 时不发请求", async () => {
    seen.length = 0;
    routes = { "/client/v4/zones/z1/purge_cache": [200, { success: true }] };
    await call({ path: "zones/z1/purge_cache", method: "POST", body: '{"purge_everything":true}' });
    expect(seen).toEqual([
      {
        method: "POST", url: "/client/v4/zones/z1/purge_cache", auth: "Bearer tok-a", type: "application/json",
        body: '{"purge_everything":true}',
      },
    ]);
    const bad = await call({ path: "zones", method: "POST", body: "{oops" });
    expect(bad.isError).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("403 或 success 为 false 时报错，带回错误信息", async () => {
    routes = {
      "/client/v4/zones": [403, { success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] }],
      "/client/v4/user": [200, { success: false, errors: [{ message: "nope" }] }],
    };
    const r = await call({ path: "zones" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^http=403\n.*Unauthorized to access requested resource/);
    expect((await call({ path: "user" })).isError).toBe(true);
  });

  it("输出给密钥打码，并按 max_chars 截断", async () => {
    routes = { "/client/v4/big": [200, { success: true, result: { note: "password=supersecret123", pad: "x".repeat(3000) } }] };
    const out = textOf(await call({ path: "big", max_chars: 500 }));
    expect(out).toContain("<redacted>");
    expect(out).not.toContain("supersecret123");
    expect(out).toContain("中间省略");
  });

  it("path 里的域名先换成 zone_id", async () => {
    seen.length = 0;
    routes = {
      "/client/v4/zones?name=example.com": [200, { success: true, result: [{ id: "zid123" }] }],
      "/client/v4/zones/zid123/dns_records": [200, { success: true, result: [{ id: "r1" }] }],
      "/client/v4/zones/zid123/dns_records?type=A": [200, { success: true, result: [{ id: "r1" }] }],
    };
    expect((await call({ path: "zones/example.com/dns_records" })).isError).toBeUndefined();
    expect((await call({ path: "zones/example.com/dns_records?type=A" })).isError).toBeUndefined();
    expect(seen.map((s) => s.url)).toEqual([
      "/client/v4/zones?name=example.com",
      "/client/v4/zones/zid123/dns_records",
      "/client/v4/zones?name=example.com",
      "/client/v4/zones/zid123/dns_records?type=A",
    ]);
  });

  it("域名查不到时报错，写明找不到该域名", async () => {
    routes = { "/client/v4/zones?name=nope.org": [200, { success: true, result: [] }] };
    const r = await call({ path: "zones/nope.org/dns_records" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("找不到域名 nope.org");
  });
});
