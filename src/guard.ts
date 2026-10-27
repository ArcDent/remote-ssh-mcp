/**
 * Best-effort check for power and package-management commands in command position.
 * It is a seatbelt against agent mistakes, not a sandbox: nested ssh, docker exec, eval
 * or scripts written to disk are not inspected.
 */

const POWER = new Set(["reboot", "shutdown", "poweroff", "halt"]);
const SYSTEMCTL_POWER = new Set(["reboot", "poweroff", "halt", "kexec", "soft-reboot"]);
const PKG = new Set(["apt", "apt-get", "aptitude", "yum", "dnf", "apk", "dpkg"]);
const PKG_SUBCOMMANDS = new Set([
  "install", "reinstall", "remove", "purge", "autoremove", "upgrade", "dist-upgrade",
  "full-upgrade", "add", "del", "erase", "downgrade",
]);
const DPKG_FLAGS = /^(-i|-r|-P|--install|--remove|--purge|--configure|--unpack)$/;
const WRAPPERS = new Set([
  "sudo", "nohup", "exec", "command", "env", "nice", "ionice", "time", "stdbuf", "setsid",
  "!", "then", "do", "else", "elif", "if", "while", "until", "{", "(",
]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ash"]);

export type Danger = { kind: "power" | "pkg"; word: string };

export interface GuardEnv {
  allowPower: boolean;
  allowPkg: boolean;
}

export function guardEnv(env: NodeJS.ProcessEnv = process.env): GuardEnv {
  return { allowPower: env.SSH_MCP_ALLOW_POWER === "1", allowPkg: env.SSH_MCP_ALLOW_PKG === "1" };
}

/** Returns a refusal message, or null when the command may run. */
export function checkCommand(cmd: string, env: GuardEnv = guardEnv()): string | null {
  for (const d of findDangers(cmd)) {
    if (d.kind === "power" && !env.allowPower) {
      return `Blocked: power command "${d.word}". Ask the user to run it manually over ssh (or set SSH_MCP_ALLOW_POWER=1).`;
    }
    if (d.kind === "pkg" && !env.allowPkg) {
      return `Blocked: package command "${d.word}". Ask the user to run it manually over ssh (or set SSH_MCP_ALLOW_PKG=1).`;
    }
  }
  return null;
}

export function findDangers(cmd: string, depth = 0): Danger[] {
  const found: Danger[] = [];
  for (const seg of segments(cmd)) {
    const words = splitWords(seg);
    let i = 0;
    let wrapper = "";
    while (i < words.length) {
      const w = words[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        i++;
      } else if (WRAPPERS.has(w) || w === "timeout") {
        wrapper = w;
        i++;
        if (w === "timeout") {
          while (words[i]?.startsWith("-")) i++;
          i++; // duration
        }
      } else if (wrapper && w.startsWith("-")) {
        // sudo -u USER, nice -n N, ionice -c N: these flags take a value
        i += /^-[ugUCDhprtTnc]$/.test(w) && ["sudo", "nice", "ionice"].includes(wrapper) ? 2 : 1;
      } else break;
    }
    if (i >= words.length) continue;
    const name = words[i].split("/").pop()!;
    const rest = words.slice(i + 1);
    const firstArg = rest.find((a) => !a.startsWith("-"));

    if (POWER.has(name)) found.push({ kind: "power", word: name });
    else if ((name === "init" || name === "telinit") && (firstArg === "0" || firstArg === "6")) {
      found.push({ kind: "power", word: `${name} ${firstArg}` });
    } else if (name === "systemctl" && firstArg && SYSTEMCTL_POWER.has(firstArg)) {
      found.push({ kind: "power", word: `systemctl ${firstArg}` });
    } else if (name === "dpkg" && rest.some((a) => DPKG_FLAGS.test(a))) {
      found.push({ kind: "pkg", word: "dpkg" });
    } else if (PKG.has(name) && name !== "dpkg" && firstArg && PKG_SUBCOMMANDS.has(firstArg)) {
      found.push({ kind: "pkg", word: `${name} ${firstArg}` });
    } else if (SHELLS.has(name) && depth < 3) {
      const c = rest.indexOf("-c");
      if (c >= 0 && rest[c + 1] !== undefined) found.push(...findDangers(rest[c + 1], depth + 1));
    }
  }
  return found;
}

/**
 * Splits a shell command into simple-command segments on ; & | && || newlines, ( ) and
 * command substitutions, ignoring separators inside quotes.
 */
export function segments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let q: "'" | '"' | null = null;
  const push = () => {
    if (cur.trim()) segs.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") {
      cur += c;
      if (c === "'") q = null;
      continue;
    }
    if (c === "\\") {
      cur += c + (cmd[i + 1] ?? "");
      i++;
      continue;
    }
    if (q === '"') {
      if (c === '"') {
        cur += c;
        q = null;
      } else if (c === "`" || (c === "$" && cmd[i + 1] === "(")) {
        // Command substitution runs even inside double quotes: treat it as a new command.
        push();
        q = null;
        if (c === "$") i++;
      } else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === "$" && cmd[i + 1] === "(") {
      push();
      i++;
    } else if (";&|\n()`".includes(c)) {
      push();
    } else cur += c;
  }
  push();
  return segs;
}

/** Whitespace split that keeps quoted strings together and strips their quotes. */
export function splitWords(seg: string): string[] {
  const words: string[] = [];
  let cur = "";
  let q: "'" | '"' | null = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === "\\") {
      cur += seg[i + 1] ?? "";
      i++;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words;
}
