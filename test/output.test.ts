import { describe, expect, it } from "vitest";
import { allocate, compactJson, formatResult, formatSections, redact, truncate } from "../src/output.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}`).join("\n") + "\n";

describe("truncate", () => {
  it("短输出原样返回", () => {
    expect(truncate("abc\n", 10)).toBe("abc\n");
  });

  it("在上限内保留完整的首尾行，并写明省略了多少", () => {
    const s = lines(200000);
    const t = truncate(s, 8000);
    const body = t.replace(/\.\.\.\[中间省略 \d+ 字符\]\.\.\.\n/, "");
    expect(body.length).toBeLessThanOrEqual(8000);
    expect(t.startsWith("1\n2\n")).toBe(true);
    expect(t.endsWith("199999\n200000\n")).toBe(true);
    const omitted = Number(/中间省略 (\d+) 字符/.exec(t)![1]);
    expect(omitted + body.length).toBe(s.length);
  });
});

describe("compactJson", () => {
  it("把 JSON 文档压成一行", () => {
    expect(compactJson('{"a": 1,  "b": [1, 2]}\n')).toBe('{"a":1,"b":[1,2]}\n');
    expect(compactJson('[\n  {"x": "y z"}\n]')).toBe('[{"x":"y z"}]\n');
  });

  it("非 JSON 和混合输出原样不动", () => {
    for (const s of ["hello\n", '{"a":1}\nextra\n', "[not json", "42\n"]) expect(compactJson(s)).toBe(s);
  });
});

describe("formatResult", () => {
  it("显示退出码、标准输出，标准错误有内容时才显示", () => {
    const r = formatResult({ code: 0, stdout: "ok\n", stderr: "", timedOut: false, timeoutS: 60 });
    expect(r.content).toEqual([{ type: "text", text: "exit=0\nok" }]);
    expect(r.isError).toBeUndefined();
    const e = formatResult({ code: 2, stdout: "", stderr: "boom\n", timedOut: false, timeoutS: 60 });
    expect(e.content[0]).toEqual({ type: "text", text: "exit=2\n[stderr]\nboom" });
  });

  it("主机停止命令时报告超时，并带上已有的输出", () => {
    const r = formatResult({
      code: 124, stdout: "started\n", stderr: "", timedOut: false, timeoutS: 5, remoteTimedOut: true, durationMs: 5230,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toEqual({
      type: "text",
      text: "超时：命令运行 5.2s 后被主机停止（上限 5s，exit=124），以下是停止前的输出\nstarted",
    });
  });

  it("报告调用被取消", () => {
    const r = formatResult({ code: null, stdout: "", stderr: "", timedOut: false, timeoutS: 60, cancelled: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toEqual({ type: "text", text: "客户端取消了调用" });
  });

  it("超时和 ssh 错误标为出错", () => {
    const t = formatResult({ code: null, stdout: "", stderr: "", timedOut: true, timeoutS: 4, durationMs: 14360 });
    expect(t.isError).toBe(true);
    expect(t.content[0]).toMatchObject({
      text: expect.stringMatching(/^超时：等了 14\.4s 后本机断开了 ssh（上限 4s），命令可能还在主机上运行/),
    });
    const r = formatResult({ code: 255, stdout: "", stderr: "Connection refused\n", timedOut: false, timeoutS: 60 });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("ssh 连接出错") });
  });
});

describe("allocate", () => {
  it("短文本拿足所需，剩下的给长文本", () => {
    expect(allocate([100, 10000], 4000)).toEqual([100, 3900]);
    expect(allocate([5000, 50, 5000], 4000)).toEqual([1975, 50, 1975]);
    expect(allocate([10, 20], 4000)).toEqual([10, 20]);
  });
});

describe("formatSections", () => {
  const res = (stdout: string, code = 0) => ({ code, stdout, stderr: "", timedOut: false, timeoutS: 60 });

  it("每段标上标签和退出码", () => {
    const r = formatSections([{ label: "a", result: res("x\n") }, { label: "b", result: res("", 3) }]);
    expect(r.content[0]).toEqual({ type: "text", text: "== a exit=0\nx\n== b exit=3" });
    expect(r.isError).toBeUndefined();
  });

  it("各段共用 max_chars，短段挨着长段也能保持完整", () => {
    const short = "s".repeat(99) + "\n";
    const long = lines(3000);
    const t = String(formatSections([{ label: "short", result: res(short) }, { label: "long", result: res(long) }], 4000).content[0].text);
    expect(t).toContain(short);
    const longBody = t.slice(t.indexOf("== long exit=0\n") + "== long exit=0\n".length).replace(/\.\.\.\[中间省略 \d+ 字符\]\.\.\.\n/, "");
    expect(longBody.length).toBeLessThanOrEqual(3900);
    expect(longBody.length).toBeGreaterThan(3800);
  });

  it("任一段在 ssh 层面失败时整体标为出错", () => {
    const r = formatSections([{ label: "a", result: res("") }, { label: "b", result: { ...res(""), code: 255 } }]);
    expect(r.isError).toBe(true);
  });
});

describe("redact", () => {
  it.each([
    ["password=hunter2xyz", "password=<redacted>"],
    ["api_key: sk-abcdefghijklmnop", "api_key: <redacted>"],
    ["Authorization: Bearer abcdefghijkl", "Authorization: Bearer <redacted>"],
    ['{"password":"abc123xyz","user":"root"}', '{"password":"<redacted>","user":"root"}'],
    ["management-key: s3cr3tvalue", "management-key: <redacted>"],
    ["export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuv", "export GITHUB_TOKEN=<redacted>"],
    ["tailscale up --authkey hskey-auth-abcdef123456", "tailscale up --authkey <redacted>"],
    ["proxy http://user:pa55word@10.0.0.1:8080", "proxy http://user:<redacted>@10.0.0.1:8080"],
  ])("打码 %s", (input, masked) => {
    expect(redact(input)).toBe(masked);
  });

  it.each([
    "key_file: /etc/ssl/x.key",
    "token_count: 12",
    '"total_tokens": 123456',
    "secret: false",
    "password: $DB_PASS",
    "PasswordAuthentication no",
    "password=<redacted>",
  ])("不打码 %s", (input) => {
    expect(redact(input)).toBe(input);
  });

  it("格式化结果默认打码，也可以关掉", () => {
    const r = { code: 0, stdout: "token=abcdef123456\n", stderr: "", timedOut: false, timeoutS: 60 };
    expect(formatResult(r).content[0]).toMatchObject({ text: "exit=0\ntoken=<redacted>" });
    expect(formatResult(r, 4000, false).content[0]).toMatchObject({ text: "exit=0\ntoken=abcdef123456" });
  });
});
