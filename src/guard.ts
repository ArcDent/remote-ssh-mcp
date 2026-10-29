/**
 * 尽力找出处在命令位置的电源类和装包类命令。比较命令名时不分大小写、不带 `.exe`，和 Windows
 * 运行它们时一样。这是防 agent 误操作的安全带，不是沙箱：嵌套 ssh、docker exec、
 * python -c / perl -e、Start-Process 和先写进文件再运行的脚本都不检查。
 */

const POWER = new Set(["reboot", "shutdown", "poweroff", "halt"]);
const SYSTEMCTL_POWER = new Set(["reboot", "poweroff", "halt", "kexec", "soft-reboot"]);
/** 会启动单元的子命令，以及一启动就会让主机关机或重启的 target。 */
const SYSTEMCTL_STARTERS = new Set([
  "start", "restart", "isolate", "try-restart", "reload-or-restart", "try-reload-or-restart",
]);
const POWER_TARGETS = new Set([
  "reboot.target", "poweroff.target", "halt.target", "kexec.target", "soft-reboot.target", "ctrl-alt-del.target",
]);
const PKG = new Set(["apt", "apt-get", "aptitude", "yum", "dnf", "apk", "dpkg"]);
const APT = new Set(["apt", "apt-get", "aptitude"]);
const PKG_SUBCOMMANDS = new Set([
  "install", "reinstall", "remove", "purge", "autoremove", "upgrade", "dist-upgrade",
  "full-upgrade", "add", "del", "erase", "downgrade",
]);
/** 只演示、不真正执行的 apt 选项。 */
const APT_SIMULATE = new Set(["--simulate", "--dry-run", "--just-print", "--no-act", "--recon"]);
const DPKG_FLAGS = /^(-i|-r|-P|--install|--remove|--purge|--configure|--unpack)$/;
const WIN_PKG = new Set(["choco", "winget", "scoop"]);
const WIN_PKG_SUBCOMMANDS = new Set(["install", "uninstall", "upgrade", "update", "remove", "add"]);
/** msiexec 的安装和卸载开关；Git Bash 下要写 `//i`，否则 `/i` 会被转成路径。 */
const MSIEXEC_FLAGS = /^(-|\/\/?)(i|x|package|uninstall)$/i;
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ash"]);
/** Windows PowerShell 里带值的选项，分全名和别名两组；全名写成任何不会混淆的前缀也认。 */
const PS_VALUE_OPTS = [
  "executionpolicy", "outputformat", "inputformat", "windowstyle", "version", "configurationname",
  "workingdirectory", "settingsfile", "custompipename", "psconsolefile",
];
const PS_VALUE_ALIASES = new Set(["ep", "ex", "of", "o", "if", "inp", "w", "v", "config", "wd"]);

/** 带值的选项。它们后面那个词是选项的值，不是命令或子命令。 */
interface ValueOpts {
  /** 短选项字母，合写时排在最后也算（`-nu root`）。 */
  short: string;
  /** 长选项名，指不带 `=` 的写法。 */
  long: string[];
}
const opts = (short: string, ...long: string[]): ValueOpts => ({ short, long });
const NO_OPTS = opts("");

/** 把后面的内容当命令运行的包装命令，以及各自带值的选项。 */
const WRAPPERS = new Map<string, ValueOpts>([
  ["sudo", opts("ugUCDhprtTR", "user", "group", "other-user", "host", "prompt", "chdir", "chroot", "role", "type", "close-from", "command-timeout")],
  ["doas", opts("uC")],
  ["nice", opts("n", "adjustment")],
  ["ionice", opts("cnp", "class", "classdata", "pid")],
  ["timeout", opts("sk", "signal", "kill-after")],
  ["xargs", opts("adEILnPs", "arg-file", "delimiter", "max-lines", "max-args", "max-procs", "max-chars", "process-slot-var")],
  ["stdbuf", opts("ioe", "input", "output", "error")],
  ["env", opts("uC", "unset", "chdir")],
  ["time", opts("fo", "format", "output")],
  ["exec", opts("a")],
  ["busybox", NO_OPTS],
  ...["nohup", "command", "setsid", "!", "then", "do", "else", "elif", "if", "while", "until", "{", "("].map(
    (w): [string, ValueOpts] => [w, NO_OPTS],
  ),
]);
const SYSTEMCTL_OPTS = opts("HMtpnos", "host", "machine", "type", "property", "lines", "output", "signal", "state", "kill-whom", "root", "job-mode", "what");
const APT_OPTS = opts("octa", "option", "config-file", "target-release", "host-architecture");

type Danger = { kind: "power" | "pkg"; word: string };

interface GuardEnv {
  allowPower: boolean;
  allowPkg: boolean;
}

export function guardEnv(env: NodeJS.ProcessEnv = process.env): GuardEnv {
  return { allowPower: env.SSH_MCP_ALLOW_POWER === "1", allowPkg: env.SSH_MCP_ALLOW_PKG === "1" };
}

/** 返回拒绝理由；命令可以运行时返回 null。`powershell` 为 true 时按 PowerShell 的规则检查。 */
export function checkCommand(cmd: string, env: GuardEnv = guardEnv(), powershell = false): string | null {
  for (const d of powershell ? findPwshDangers(cmd) : findDangers(cmd)) {
    if (d.kind === "power" && !env.allowPower) {
      return `已拦截电源类命令「${d.word}」。请让用户自己 ssh 上去执行，或设置 SSH_MCP_ALLOW_POWER=1 放开。`;
    }
    if (d.kind === "pkg" && !env.allowPkg) {
      return `已拦截装包类命令「${d.word}」。请让用户自己 ssh 上去执行，或设置 SSH_MCP_ALLOW_PKG=1 放开。`;
    }
  }
  return null;
}

export function findDangers(cmd: string, depth = 0): Danger[] {
  const found: Danger[] = [];
  for (const seg of segments(cmd)) {
    const words = splitWords(seg);
    // 不管用什么命令，写这个文件都会触发内核动作（b 重启，o 关机）。
    if (words.some((w) => w.includes("sysrq-trigger"))) {
      found.push({ kind: "power", word: "/proc/sysrq-trigger" });
      continue;
    }
    const c = commandOf(words);
    if (c) found.push(...classify(c.name, c.rest, depth));
  }
  return found;
}

/**
 * 判断一条命令是不是电源类或装包类（`name` 已转小写、去掉 `.exe`）。交给 shell、su -c、eval、
 * cmd /c 和 powershell -Command 的脚本递归检查。
 */
function classify(name: string, rest: string[], depth: number): Danger[] {
  if (POWER.has(name)) return [{ kind: "power", word: name }];
  if (name === "init" || name === "telinit") {
    const [level] = positionals(rest, NO_OPTS);
    if (level === "0" || level === "6") return [{ kind: "power", word: `${name} ${level}` }];
  }
  if (name === "systemctl") {
    const [verb, ...units] = positionals(rest, SYSTEMCTL_OPTS);
    if (verb && SYSTEMCTL_POWER.has(verb)) return [{ kind: "power", word: `systemctl ${verb}` }];
    if (verb && SYSTEMCTL_STARTERS.has(verb)) {
      // isolate 会给不带后缀的名字补上 .target
      const unit = units.find((u) => POWER_TARGETS.has(verb === "isolate" && !u.includes(".") ? `${u}.target` : u));
      if (unit) return [{ kind: "power", word: `systemctl ${verb} ${unit}` }];
    }
  }
  if (name === "dpkg" && rest.some((a) => DPKG_FLAGS.test(a))) return [{ kind: "pkg", word: "dpkg" }];
  if (PKG.has(name) && name !== "dpkg") {
    const apt = APT.has(name);
    const [sub] = positionals(rest, apt ? APT_OPTS : NO_OPTS);
    if (sub && PKG_SUBCOMMANDS.has(sub) && !(apt && simulates(rest))) return [{ kind: "pkg", word: `${name} ${sub}` }];
  }
  const arg = rest.find((a) => !/^[-/]/.test(a))?.toLowerCase();
  if (name === "wpeutil" && (arg === "reboot" || arg === "shutdown")) return [{ kind: "power", word: `wpeutil ${arg}` }];
  if (WIN_PKG.has(name) && arg && WIN_PKG_SUBCOMMANDS.has(arg)) return [{ kind: "pkg", word: `${name} ${arg}` }];
  if (name === "msiexec" && rest.some((a) => MSIEXEC_FLAGS.test(a))) return [{ kind: "pkg", word: "msiexec" }];
  if (depth >= 3) return [];
  if (name === "eval") return findDangers(rest.join(" "), depth + 1);
  if (name === "cmd") {
    const k = rest.findIndex((a) => /^\/\/?[ck]$/i.test(a));
    return k < 0 ? [] : findDangers(rest.slice(k + 1).join(" "), depth + 1);
  }
  if (name === "powershell" || name === "pwsh") {
    const script = psCommandArg(name, rest);
    return script === undefined ? [] : findPwshDangers(script, depth + 1);
  }
  const script = name === "su" ? suCommand(rest) : SHELLS.has(name) ? shellArgs(rest).script : undefined;
  return script === undefined ? [] : findDangers(script, depth + 1);
}

/**
 * 取出 powershell/pwsh 命令行要运行的脚本：-Command（或 -c）后面的内容、解码后的
 * -EncodedCommand，或者对 Windows PowerShell 取第一个位置参数及之后的内容（pwsh 会把它当文件）。
 * 用 -File、运行文件或没有脚本时返回 undefined。
 */
function psCommandArg(name: string, rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const p = rest[i].toLowerCase().replace(/^(--?|\/\/?)/, "");
    if (p === rest[i].toLowerCase()) return name === "powershell" ? rest.slice(i).join(" ") : undefined;
    if (p === "c" || (p.length >= 3 && "command".startsWith(p))) return rest.slice(i + 1).join(" ");
    if (p === "e" || p === "ec" || (p.length >= 3 && "encodedcommand".startsWith(p))) {
      return Buffer.from(rest[i + 1] ?? "", "base64").toString("utf16le");
    }
    if (p === "f" || (p.length >= 2 && "file".startsWith(p))) return undefined;
    if (PS_VALUE_ALIASES.has(p) || (p.length >= 3 && PS_VALUE_OPTS.some((o) => o.startsWith(p)))) i++;
  }
  return undefined;
}

/** 带 `-s`、`--simulate` 这类选项，合写在短选项里也算（`-ys`）。 */
function simulates(rest: string[]): boolean {
  return rest.some((a) => APT_SIMULATE.has(a) || (/^-[a-zA-Z]+$/.test(a) && a.includes("s")));
}

/**
 * 看 shell 是怎么启动的：短选项里含 `c`（`-c`、`-lc`、`-ec`）时 `dashC` 为 true，这时 `script`
 * 是第一个不是选项的参数。`-o`、`+o`、`-O` 带值。
 */
function shellArgs(rest: string[]): { dashC: boolean; script?: string } {
  let dashC = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") return { dashC, script: dashC ? rest[i + 1] : undefined };
    if (/^[-+][oO]$/.test(a)) i++;
    else if (/^[-+][a-zA-Z]+$/.test(a)) dashC ||= a[0] === "-" && a.includes("c");
    else if (!a.startsWith("--")) return { dashC, script: dashC ? a : undefined };
  }
  return { dashC };
}

/** su 要运行的命令：-c 或 --command 的值（`-lc cmd` 也算）；只开登录 shell 时返回 undefined。 */
function suCommand(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-c" || a === "--command") return rest[i + 1];
    if (a.startsWith("--command=")) return a.slice("--command=".length);
    if (/^-[a-zA-Z]+$/.test(a) && a.includes("c")) {
      const k = a.indexOf("c");
      return k === a.length - 1 ? rest[i + 1] : a.slice(k + 1);
    }
  }
  return undefined;
}

/** 从 `i` 起找第一个既不是 `o` 的选项、也不是选项值的词，返回它的下标。 */
function skipOptions(words: string[], i: number, o: ValueOpts): number {
  while (i < words.length) {
    const a = words[i];
    if (a === "--") return i + 1;
    if (a.startsWith("--")) i += !a.includes("=") && o.long.includes(a.slice(2)) ? 2 : 1;
    else if (a.length > 1 && a.startsWith("-")) {
      // 合写的短选项里，第一个带值的字母把后面剩下的字符当值；它排在最后时，值是下一个词。
      const k = [...a.slice(1)].findIndex((ch) => o.short.includes(ch));
      i += k >= 0 && k === a.length - 2 ? 2 : 1;
    } else break;
  }
  return i;
}

/** 命令的位置参数，跳过选项和选项的值。 */
function positionals(rest: string[], o: ValueOpts): string[] {
  const out: string[] = [];
  for (let i = skipOptions(rest, 0, o); i < rest.length; i = skipOptions(rest, i + 1, o)) out.push(rest[i]);
  return out;
}

const PS_POWER = new Set(["restart-computer", "stop-computer"]);
const PS_PKG = new Set(["install-package", "uninstall-package", "add-appxpackage", "remove-appxpackage"]);

/**
 * findDangers 的 PowerShell 版。Invoke-Expression 里的字符串递归检查；在 PowerShell 里运行的原生
 * 命令（shutdown、winget、cmd /c，或 Linux 上 pwsh 里的 apt-get）按 POSIX 规则检查。
 */
export function findPwshDangers(cmd: string, depth = 0): Danger[] {
  const found: Danger[] = [];
  for (const seg of segments(cmd, true)) {
    const words = splitWords(seg, true);
    const i = words[0] === "." ? 1 : 0; // 跳过点源调用（dot-sourcing）的 .
    if (i >= words.length) continue;
    const name = baseName(words[i]);
    const rest = words.slice(i + 1);
    if (PS_POWER.has(name)) found.push({ kind: "power", word: words[i] });
    else if (PS_PKG.has(name)) found.push({ kind: "pkg", word: words[i] });
    else if (name === "invoke-expression" || name === "iex") {
      // 去掉指明字符串的 -Command（或它的前缀写法）。
      const expr = rest.filter((a) => !(a.length > 1 && "-command".startsWith(a.toLowerCase())));
      if (depth < 3) found.push(...findPwshDangers(expr.join(" "), depth + 1));
    } else found.push(...classify(name, rest, depth));
  }
  return found;
}

/** 按 Windows 的方式取命令名：去掉目录，转小写，去掉 `.exe`。 */
function baseName(word: string): string {
  return word.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
}

/**
 * `cmd` 里有命令把标准输入当脚本运行时为 true：不带 `-c` 的 shell（`sh`、`bash -s`、`sudo bash`），
 * 或不带 -c 的 su。这时标准输入要和命令一样过检查。
 */
export function stdinIsScript(cmd: string): boolean {
  return segments(cmd).some((seg) => {
    const c = commandOf(splitWords(seg));
    if (!c) return false;
    return (SHELLS.has(c.name) && !shellArgs(c.rest).dashC) || (c.name === "su" && suCommand(c.rest) === undefined);
  });
}

/** 跳过变量赋值和 sudo 这类包装命令，取简单命令的命令名（按 baseName 处理）和参数。 */
function commandOf(words: string[]): { name: string; rest: string[] } | null {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const wrapper = WRAPPERS.get(w);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (wrapper) {
      i = skipOptions(words, i + 1, wrapper);
      if (w === "timeout") i++; // 跳过时长参数
    } else break;
  }
  if (i >= words.length) return null;
  return { name: baseName(words[i]), rest: words.slice(i + 1) };
}

/**
 * 在 ; & | && || 换行、( ) 和命令替换处把 shell 命令拆成一段段简单命令，引号里的分隔符不算。
 * `ps` 为 true 时按 PowerShell 拆语句：转义符换成反引号，花括号也是分隔符。
 */
function segments(cmd: string, ps = false): string[] {
  const esc = ps ? "`" : "\\";
  const seps = ps ? ";|&\n{}()" : ";&|\n()`";
  const segs: string[] = [];
  let cur = "";
  let q: "'" | '"' | null = null;
  const push = () => {
    if (cur.trim()) segs.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === esc && q !== "'") {
      cur += c + (cmd[i + 1] ?? "");
      i++;
    } else if (q) {
      if (c === q) {
        cur += c;
        q = null;
      } else if (q === '"' && (c === "`" || (c === "$" && cmd[i + 1] === "("))) {
        // 双引号里的命令替换照样会执行，当成一条新命令。
        push();
        q = null;
        if (c === "$") i++;
      } else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (!ps && c === "$" && cmd[i + 1] === "(") {
      push();
      i++;
    } else if (seps.includes(c)) push();
    else cur += c;
  }
  push();
  return segs;
}

/** 按空白拆词，引号里的内容不拆开，引号去掉。`ps` 为 true 时转义符是反引号，在双引号里也生效。 */
function splitWords(seg: string, ps = false): string[] {
  const esc = ps ? "`" : "\\";
  const words: string[] = [];
  let cur = "";
  let q: "'" | '"' | null = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === esc && (!q || (ps && q === '"'))) {
      cur += seg[i + 1] ?? "";
      i++;
      has = true;
    } else if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
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
