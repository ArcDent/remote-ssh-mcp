import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

const DEFAULT_SSH_CONFIG = join(homedir(), ".ssh", "config");

/** ssh config 及其 Include 的文件里写明的 Host 别名，不含通配和取反模式。 */
export function listHosts(configPath = DEFAULT_SSH_CONFIG): string[] {
  const hosts = new Set<string>();
  collect(configPath, hosts, new Set());
  return [...hosts];
}

/** `host` 不是其中之一时抛错，报错里列出所有可用别名。 */
export function assertHost(host: string, configPath = DEFAULT_SSH_CONFIG): void {
  const hosts = listHosts(configPath);
  if (!hosts.includes(host)) {
    throw new Error(`未知主机「${host}」。请用 ~/.ssh/config 里的别名：${hosts.join(", ")}`);
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

/** Include 的相对路径按 ~/.ssh 解析；支持 `~`，路径最后一段支持 `*`、`?` 通配。 */
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
