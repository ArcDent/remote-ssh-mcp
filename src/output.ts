import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SshResult } from "./ssh.js";

export const DEFAULT_MAX_CHARS = 4000;

/** 把 `s` 截到 `max` 字符以内，保留开头和结尾，在行边界处切开。 */
export function truncate(s: string, max = DEFAULT_MAX_CHARS): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  let head = s.slice(0, half);
  let tail = s.slice(s.length - half);
  const lastNl = head.lastIndexOf("\n");
  if (lastNl > 0) head = head.slice(0, lastNl + 1);
  const firstNl = tail.indexOf("\n");
  if (firstNl >= 0 && firstNl < tail.length - 1) tail = tail.slice(firstNl + 1);
  const omitted = s.length - head.length - tail.length;
  return `${head}${head.endsWith("\n") ? "" : "\n"}...[中间省略 ${omitted} 字符]...\n${tail}`;
}

/** `s` 整体是一个 JSON 对象或数组时，重新序列化成一行。 */
export function compactJson(s: string): string {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return s;
  try {
    return JSON.stringify(JSON.parse(t)) + "\n";
  } catch {
    return s;
  }
}

/**
 * 把 `budget` 个字符的额度分给几段长度已知的文本：放得进平均份额的文本全部保留，省下的额度让给
 * 更长的文本。
 */
export function allocate(lengths: number[], budget: number): number[] {
  const out = new Array<number>(lengths.length).fill(0);
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  let left = budget;
  order.forEach(({ len, i }, k) => {
    out[i] = Math.min(len, Math.floor(left / (order.length - k)));
    left -= out[i];
  });
  return out;
}

export const REDACTED = "<redacted>";

/** 名字看得出是密钥的 `name: value` 或 `name=value`，JSON 写法也算。 */
const SECRET_FIELD =
  /([\w.-]*(?:pass(?:wd|word)?|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key|management[_-]?key|authorization)[\w.-]*["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\b)([^\s"',;]+)/gi;
/** 单凭格式就认得出的凭据。 */
const SECRET_SHAPES = [
  /\b(Bearer|Basic)\s+[\w.~+/=-]{6,}/g,
  /\b(?:sk-[\w-]{16,}|ghp_\w{20,}|github_pat_\w{20,}|hskey-[\w-]{10,}|xox[abp]-[\w-]{10,}|AKIA[0-9A-Z]{16})/g,
  /(\b[a-z][\w+.-]*:\/\/[^/\s:@]+:)[^@\s/]{3,}@/gi,
];

/**
 * 把命令输出里的密钥值换成 REDACTED。像路径、变量引用或占位符的值，纯数字（如 token 计数），
 * 以及不到 6 个字符的值（如开关），都不打码。
 */
export function redact(s: string): string {
  let out = s.replace(SECRET_FIELD, (m, name: string, value: string) =>
    value.length < 6 || /^[/${<]/.test(value) || /^\d+$/.test(value) ? m : name + REDACTED,
  );
  out = out.replace(SECRET_SHAPES[0], (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(SECRET_SHAPES[1], REDACTED);
  return out.replace(SECRET_SHAPES[2], (_m, prefix: string) => `${prefix}${REDACTED}@`);
}

export function text(t: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: "text", text: t }], isError } : { content: [{ type: "text", text: t }] };
}

/** 返回 `exit=N`；命令不是自己退出的，就说明是什么让它停下的。 */
function status(r: SshResult): string {
  // 实际等待的时间可能明显超过上限：主机发 KILL 前有宽限，本机 ssh 也有自己的宽限。
  const ran = `${((r.durationMs ?? r.timeoutS * 1000) / 1000).toFixed(1)}s`;
  if (r.remoteTimedOut) {
    return `超时：命令运行 ${ran} 后被主机停止（上限 ${r.timeoutS}s，exit=${r.code}），以下是停止前的输出`;
  }
  if (r.cancelled) return "客户端取消了调用";
  if (r.timedOut) {
    return `超时：等了 ${ran} 后本机断开了 ssh（上限 ${r.timeoutS}s），命令可能还在主机上运行`;
  }
  if (r.code === 255) return "exit=255（ssh 连接出错）";
  return `exit=${r.code}`;
}

function failed(r: SshResult): boolean {
  return r.timedOut || !!r.remoteTimedOut || r.code === 255 || r.code === null;
}

/** 依次是状态行、标准输出、标准错误（有内容才加），各自按自己的上限截断。 */
function body(r: SshResult, stdout: string, stderr: string, outCap: number, errCap: number): string[] {
  const lines = [status(r)];
  const o = truncate(stdout, outCap);
  const e = truncate(stderr, errCap);
  if (o) lines.push(o.replace(/\n$/, ""));
  if (e.trim()) lines.push("[stderr]", e.replace(/\n$/, ""));
  return lines;
}

function clean(s: string, mask: boolean, json = false): string {
  const t = json ? compactJson(s) : s;
  return mask ? redact(t) : t;
}

/** 先是 `exit=N` 行，再是标准输出和标准错误（有内容才加）；输出会经过 JSON 压缩、打码和截断。 */
export function formatResult(r: SshResult, maxChars = DEFAULT_MAX_CHARS, mask = true): CallToolResult {
  return text(body(r, clean(r.stdout, mask, true), clean(r.stderr, mask), maxChars, maxChars).join("\n"), failed(r));
}

/**
 * 每个结果一段，段首是 `== label exit=N`。各段共用每路 maxChars 的额度，一段输出很长时也挤不掉
 * 短的段。
 */
export function formatSections(
  sections: { label: string; result: SshResult }[],
  maxChars = DEFAULT_MAX_CHARS,
  mask = true,
): CallToolResult {
  const outs = sections.map((s) => clean(s.result.stdout, mask, true));
  const errs = sections.map((s) => (s.result.stderr.trim() ? clean(s.result.stderr, mask) : ""));
  const outCaps = allocate(outs.map((o) => o.length), maxChars);
  const errCaps = allocate(errs.map((e) => e.length), maxChars);
  const blocks = sections.map((s, i) => {
    const [head, ...rest] = body(s.result, outs[i], errs[i], outCaps[i], errCaps[i]);
    return [`== ${s.label} ${head}`, ...rest].join("\n");
  });
  return text(blocks.join("\n"), sections.some((s) => failed(s.result)));
}
