import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SshResult } from "./ssh.js";

export const DEFAULT_MAX_CHARS = 8000;

/** Keeps the head and tail of `s` (cut on line boundaries) within `max` chars. */
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
  return `${head}${head.endsWith("\n") ? "" : "\n"}...[truncated ${omitted} chars]...\n${tail}`;
}

/** Re-serializes `s` on one line when the whole of it is a JSON object or array. */
export function compactJson(s: string): string {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return s;
  try {
    return JSON.stringify(JSON.parse(t)) + "\n";
  } catch {
    return s;
  }
}

export type ToolText = CallToolResult;

export function text(t: string, isError = false): ToolText {
  return isError ? { content: [{ type: "text", text: t }], isError } : { content: [{ type: "text", text: t }] };
}

/** `exit=N` line, then stdout, then stderr (only if any); each stream compacted and truncated. */
export function formatResult(r: SshResult, maxChars = DEFAULT_MAX_CHARS): ToolText {
  const lines: string[] = [];
  if (r.timedOut) lines.push(`timeout: killed after ${r.timeoutS}s`);
  else if (r.code === 255) lines.push("exit=255 (ssh connection error)");
  else lines.push(`exit=${r.code}`);
  const stdout = truncate(compactJson(r.stdout), maxChars);
  const stderr = truncate(r.stderr, maxChars);
  if (stdout) lines.push(stdout.replace(/\n$/, ""));
  if (stderr.trim()) lines.push("[stderr]", stderr.replace(/\n$/, ""));
  return text(lines.join("\n"), r.timedOut || r.code === 255 || r.code === null);
}
