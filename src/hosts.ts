import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export const DEFAULT_SSH_CONFIG = join(homedir(), ".ssh", "config");

/** Concrete Host aliases (no wildcard / negated patterns) from an ssh config and its Includes. */
export function listHosts(configPath = DEFAULT_SSH_CONFIG): string[] {
  const hosts = new Set<string>();
  collect(configPath, hosts, new Set());
  return [...hosts];
}

/** Throws with the list of valid aliases when `host` is not one of them. */
export function assertHost(host: string, configPath = DEFAULT_SSH_CONFIG): void {
  const hosts = listHosts(configPath);
  if (!hosts.includes(host)) {
    throw new Error(`Unknown host "${host}". Use an ~/.ssh/config alias: ${hosts.join(", ")}`);
  }
}

function collect(file: string, hosts: Set<string>, seen: Set<string>): void {
  if (seen.has(file)) return;
  seen.add(file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const args = m[2].split(/\s+/).map((a) => a.replace(/^"(.*)"$/, "$1")).filter(Boolean);
    if (key === "host") {
      for (const pattern of args) {
        if (!/[*?!]/.test(pattern)) hosts.add(pattern);
      }
    } else if (key === "include") {
      for (const pattern of args) {
        for (const inc of expandInclude(pattern)) collect(inc, hosts, seen);
      }
    }
  }
}

/** Include paths are relative to ~/.ssh; supports `~` and `*`/`?` globs in the last path segment. */
function expandInclude(pattern: string): string[] {
  let p = pattern.replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(p)) p = join(homedir(), ".ssh", p);
  const name = basename(p);
  if (!/[*?]/.test(name)) return [p];
  const dir = dirname(p);
  const re = new RegExp(
    "^" + name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  try {
    return readdirSync(dir)
      .filter((f) => re.test(f))
      .sort()
      .map((f) => join(dir, f))
      .filter((f) => statSync(f).isFile());
  } catch {
    return [];
  }
}
