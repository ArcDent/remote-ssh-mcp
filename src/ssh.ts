import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type Readable, type TransformCallback, type Writable } from "node:stream";
import { assertHost } from "./hosts.js";

const DEFAULT_TIMEOUT_S = 60;
/** Cursor 对一次工具调用最多等 60 分钟，期间有进度通知也不例外。 */
export const MAX_TIMEOUT_S = 3600;
/** 远端 `timeout` 发出 TERM 后，再等多少秒发 KILL。 */
export const KILL_GRACE_S = 5;
/** 命令运行期间发进度的间隔；Cursor 120 秒收不到进度就会丢弃这次调用。 */
const PROGRESS_INTERVAL_MS = 10_000;

const CONTROL_PATH = join(homedir(), ".ssh", "mcp-cm-%C");

/** 每次调用都加的选项：同一主机复用一条连接，从不交互询问，连不上就尽快失败。 */
const SSH_OPTIONS = [
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${CONTROL_PATH}`,
  "-o", "ControlPersist=10m",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-T",
];

/** 关掉发往 `host` 的复用连接；主机重启后这条连接已经断了，不关的话后面的调用会卡在上面。 */
export function closeMaster(host: string): void {
  spawnSync("ssh", ["-o", `ControlPath=${CONTROL_PATH}`, "-O", "exit", "--", host], { stdio: "ignore" });
}

/** 单次覆盖的连接参数，见 connArgs。 */
export interface Conn {
  hostname?: string;
  port?: number;
  user?: string;
  identity?: string;
  jump?: string;
  password?: string;
}

/** connArgs 的结果：放在 SSH_OPTIONS 前面的 ssh 选项，以及要经 askpass 交给 ssh 的密码。 */
export interface ConnArgs {
  args: string[];
  password?: string;
}

/**
 * 把 conn 换成 ssh 选项。ssh 对同一选项只认第一次给的值，这些选项放在 SSH_OPTIONS 前面，就盖过了那里的
 * 连接复用和 BatchMode。带 conn 时不复用已有连接，否则换了密钥这类参数也会走旧连接，验证不出新参数能不能
 * 连上。跳板必须是 ssh config 里的别名；改 HostName 时，对端的主机密钥必须和 known_hosts 里这个别名原来
 * 的记录一致，保证连上的还是同一台机器。参数不对时抛错。
 */
export function connArgs(host: string, c: Conn, configPath?: string): ConnArgs {
  const args = ["-o", "ControlMaster=no", "-o", "ControlPath=none"];
  if (c.jump !== undefined) {
    assertHost(c.jump, configPath);
    args.push("-J", c.jump);
  }
  if (c.port !== undefined) args.push("-p", String(c.port));
  if (c.user !== undefined) args.push("-l", c.user);
  if (c.identity !== undefined) {
    const key = localFile(c.identity);
    if (!key) throw new Error(`conn.identity 不是本机上的文件：${c.identity}`);
    args.push("-i", key, "-o", "IdentitiesOnly=yes");
  }
  if (c.hostname !== undefined) {
    const known = knownHostName(host, configPath);
    if (!known) {
      throw new Error(`known_hosts 里没有「${host}」的主机密钥，没法核对改连的地址；请先不带 conn.hostname 用别名连一次。`);
    }
    args.push(
      "-o", `HostName=${c.hostname}`, "-o", `HostKeyAlias=${known}`,
      "-o", "StrictHostKeyChecking=yes", "-o", "CheckHostIP=no",
    );
  }
  if (c.password !== undefined) {
    args.push(
      "-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=1",
      "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "StrictHostKeyChecking=accept-new",
    );
  }
  return { args, password: c.password };
}

/** 展开开头的 `~`；是本机上的普通文件时返回展开后的路径，否则返回 null。 */
export function localFile(p: string): string | null {
  const full = p.replace(/^~(?=\/|$)/, homedir());
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

/**
 * `host` 原来的主机在 known_hosts 里的名字：config 设了 HostKeyAlias 就用它，否则是 HostName，端口不是 22
 * 时写成 `[HostName]:端口`，和 ssh 记录时的写法一样。哪个 known_hosts 文件里都没有时返回 null。
 */
export function knownHostName(host: string, configPath?: string): string | null {
  const g = spawnSync("ssh", [...(configPath ? ["-F", configPath] : []), "-G", "--", host], { encoding: "utf8" });
  const conf = new Map<string, string>();
  for (const line of (g.stdout ?? "").split("\n")) {
    const i = line.indexOf(" ");
    if (i > 0) conf.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const hostname = conf.get("hostname") ?? host;
  const port = conf.get("port") ?? "22";
  const name = conf.get("hostkeyalias") ?? (port === "22" ? hostname : `[${hostname}]:${port}`);
  const files = `${conf.get("userknownhostsfile") ?? ""} ${conf.get("globalknownhostsfile") ?? ""}`.split(/\s+/);
  const found = files
    .filter(Boolean)
    .some((f) => spawnSync("ssh-keygen", ["-F", name, "-f", f.replace(/^~(?=\/|$)/, homedir())]).status === 0);
  return found ? name : null;
}

/** 带 conn.password 时 askpass 从这个环境变量取密码。 */
const SSH_PW_ENV = "MCP_SSH_PW";

/** 只给一次密码的临时 askpass 程序，写法同 sudoWrap 里的；用完调 remove 删掉。 */
function tempAskpass(): { file: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-askpass-"));
  const file = join(dir, "askpass");
  writeFileSync(file, `#!/bin/sh\n[ -e "$0.used" ] && exit 1\n: > "$0.used"\nprintf '%s\\n' "$${SSH_PW_ENV}"\n`, {
    mode: 0o700,
  });
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface SshResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutS: number;
  /** 远端的 `timeout` 包装在 timeoutS 到点时停掉了命令。 */
  remoteTimedOut?: boolean;
  /** 客户端取消了这次工具调用。 */
  cancelled?: boolean;
  durationMs?: number;
}

interface SshOptions {
  timeoutS?: number;
  /** 传流时边读边写给 ssh，读完再关掉 ssh 的标准输入。 */
  stdin?: string | Readable;
  /** 传了就不收集标准输出，边读边写进这里；ssh 结束时关掉它。 */
  stdout?: Writable;
  /** 本机 ssh 客户端过了 timeoutS 后还能多跑几秒，再被杀掉。 */
  graceS?: number;
  signal?: AbortSignal;
  /** 每隔 PROGRESS_INTERVAL_MS 调用一次，参数是已经过去的秒数。 */
  onTick?: (elapsedS: number) => void;
  conn?: ConnArgs;
}

export function clampTimeout(timeoutS?: number): number {
  return Math.min(Math.max(timeoutS ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
}

/**
 * sshd 默认每条连接最多 10 个会话（MaxSessions），而发往同一主机的 ssh 调用共用一条连接；超过后
 * ssh 仍能用，但会在标准错误里报警告。超出这个数的调用排队等待。
 */
const MAX_SESSIONS_PER_HOST = 8;

/** 同时最多放 `max` 个进入，其余按顺序排队。 */
export class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async enter(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    // 离开的一方会把名额直接交给我们，所以 `active` 不变。
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  leave(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

const gates = new Map<string, Gate>();

/**
 * 在 `host` 上运行 `remoteCmd`，效果同 `ssh host '<remoteCmd>'`：整个字符串作为一个参数交给
 * ssh，不经过本机 shell 的引号处理。
 */
export async function runSsh(host: string, remoteCmd: string, opts: SshOptions = {}): Promise<SshResult> {
  let gate = gates.get(host);
  if (!gate) gates.set(host, (gate = new Gate(MAX_SESSIONS_PER_HOST)));
  await gate.enter();
  try {
    return await spawnSsh(host, remoteCmd, opts);
  } finally {
    gate.leave();
  }
}

function spawnSsh(host: string, remoteCmd: string, opts: SshOptions): Promise<SshResult> {
  const timeoutS = clampTimeout(opts.timeoutS);
  const started = Date.now();
  return new Promise((resolve) => {
    const password = opts.conn?.password;
    const askpass = password === undefined ? undefined : tempAskpass();
    const child = spawn("ssh", [...(opts.conn?.args ?? []), ...SSH_OPTIONS, "--", host, remoteCmd], {
      stdio: ["pipe", "pipe", "pipe"],
      env: askpass && { ...process.env, SSH_ASKPASS: askpass.file, SSH_ASKPASS_REQUIRE: "force", [SSH_PW_ENV]: password },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    let done = false;
    const finish = (code: number | null, extraErr = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(ticker);
      askpass?.remove();
      if (opts.stdout && !opts.stdout.writableEnded) opts.stdout.end();
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + extraErr,
        timedOut,
        timeoutS,
        cancelled,
        durationMs: Date.now() - started,
      });
    };
    // 复用连接时，客户端把输入输出交给主连接，管道要等远端命令结束才关闭；所以这里直接返回，
    // 不等 "close" 事件。
    const kill = () => {
      child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
      finish(null);
    };
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, (timeoutS + (opts.graceS ?? 0)) * 1000);
    const ticker = setInterval(
      () => opts.onTick?.(Math.round((Date.now() - started) / 1000)),
      PROGRESS_INTERVAL_MS,
    );

    if (opts.stdout) child.stdout.pipe(opts.stdout);
    else child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.stdin.on("error", () => {});
    if (typeof opts.stdin === "object") opts.stdin.pipe(child.stdin);
    else child.stdin.end(opts.stdin ?? "");

    child.on("error", (e) => finish(null, String(e)));
    child.on("close", (code) => finish(code));
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 原样转发数据，同时统计字节数和 sha256；pipe 工具把它接在来源和去处之间。 */
export class Tap extends Transform {
  bytes = 0;
  private hash = createHash("sha256");

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    cb(null, chunk);
  }

  /** 数据传完后调用一次。 */
  sha256(): string {
    return this.hash.digest("hex");
  }
}

/**
 * 让主机自己在 `timeoutS` 后停掉 `remoteCmd`（先 TERM，KILL_GRACE_S 秒后再 KILL），命令在主机上
 * 就结束了，不会在 ssh 被杀后继续运行。命令仍在登录 shell 里运行；外层包装交给 `sh` 执行，无论
 * 登录 shell 是什么都能解析。
 *
 * MSYS 主机上 $SHELL 是 Git 的原生启动器 `bin/bash.exe`：信号只能停掉启动器，停不掉它启动的
 * bash，命令会继续运行，所以这类主机改用 MSYS 自己的 bash。这类主机上 `sh` 还要留着当 timeout
 * 的父进程：发 KILL 时 timeout 会杀掉自己所在的进程组，连它自己一起；如果经过启动器，这个退出
 * 会被读成 0。
 */
export function remoteTimeoutWrap(remoteCmd: string, timeoutS: number, msys = false): string {
  const script = msys
    ? `timeout -k ${KILL_GRACE_S} "$0" /usr/bin/bash -c "$1"; exit $?`
    : `exec timeout -k ${KILL_GRACE_S} "$0" "\${SHELL:-sh}" -c "$1"`;
  return `${sh(script)} ${timeoutS} ${shQuote(remoteCmd)}`;
}

/** 带 pswd 时 askpass 从这个环境变量取密码；sudo 运行的命令里会去掉它。 */
const PW_ENV = "MCP_SUDO_PW";

/**
 * 让 `remoteCmd` 经 sudo 以 root 身份运行（`-H` 让家目录也换成 root 的），返回新的命令行和标准输入。
 * 已经是 root 时直接运行，主机没装 sudo 也不影响。
 *
 * 不带 pswd 时用 `sudo -n`，主机要密码就直接失败，并提示传 pswd。带 pswd 时，密码作为标准输入的第一行
 * 传过去，不出现在命令行里，远端 `ps` 看不到；包装脚本读走这一行，余下的标准输入原样留给命令。密码经
 * 临时的 askpass 程序交给 sudo；askpass 只给一次密码，密码错了 sudo 不会接着试，免得连错几次锁住账号。
 */
export function sudoWrap(remoteCmd: string, stdin?: string, pswd?: string): { cmd: string; stdin?: string } {
  const asRoot = `[ "$(id -u)" = 0 ] && exec "\${SHELL:-sh}" -c "$1"
command -v sudo >/dev/null 2>&1 || { echo "sudo not found on this host" >&2; exit 127; }`;
  if (pswd === undefined) {
    const script = `${asRoot}
e=$(sudo -n true 2>&1) || { printf '%s\\n' "$e" "sudo needs a password on this host: pass pswd" >&2; exit 1; }
exec sudo -n -H -- "\${SHELL:-sh}" -c "$1"`;
    return { cmd: `${sh(script)} sh ${shQuote(remoteCmd)}`, stdin };
  }
  const script = `IFS= read -r p
${asRoot}
a=$(mktemp -d "\${HOME:-/tmp}/.mcp-askpass.XXXXXX") || exit 1
trap 'rm -rf "$a"' EXIT; trap 'exit 1' HUP INT TERM
cat > "$a/askpass" <<'EOF'
#!/bin/sh
[ -e "$0.used" ] && exit 1
: > "$0.used"
printf '%s\\n' "$${PW_ENV}"
EOF
chmod 700 "$a/askpass"
${PW_ENV}=$p SUDO_ASKPASS=$a/askpass sudo -A -H -- env -u ${PW_ENV} "\${SHELL:-sh}" -c "$1"`;
  return { cmd: `${sh(script)} sh ${shQuote(remoteCmd)}`, stdin: `${pswd}\n${stdin ?? ""}` };
}

/** 第一次调用某台主机时探测到的信息。 */
export interface HostInfo {
  /** 有 GNU 或 uutils 的 `timeout`，主机能自己停掉命令（见 remoteTimeoutWrap）。 */
  timeout: boolean;
  /**
   * 是 MSYS 主机，即登录 shell 为 Git Bash、MSYS2 或 Cygwin 的 Windows 主机：$SHELL 可能是信号
   * 穿不过去的原生启动器（见 remoteTimeoutWrap）。
   */
  msys: boolean;
}

/**
 * 解析探测输出：先是 `timeout --version` 的第一行，再是 `os=<uname -s>`。只认 GNU coreutils 和
 * uutils 的 timeout，busybox 的 timeout 没有 `-k`。
 */
export function parseProbe(out: string): HostInfo {
  return { timeout: /\b(GNU|uutils) coreutils\b/.test(out), msys: /^os=(MINGW|MSYS|CYGWIN)/m.test(out) };
}

const hostInfo = new Map<string, HostInfo>();

/**
 * 返回 `host` 的 HostInfo，每台主机只探测一次。连不上主机时探测结果不缓存，放在 `failure` 里返回。带 conn
 * 时探测也按 conn 连，别名本身连不上时照样能探测。
 */
export async function probeHost(host: string, conn?: ConnArgs): Promise<HostInfo & { failure?: SshResult }> {
  const cached = hostInfo.get(host);
  if (cached) return cached;
  const probe = 'timeout --version 2>/dev/null | head -n 1; echo "os=$(uname -s 2>/dev/null)"';
  const r = await runSsh(host, sh(probe), { timeoutS: 15, conn });
  if (r.timedOut || r.code === 255 || r.code === null) return { timeout: false, msys: false, failure: r };
  const info = parseProbe(r.stdout);
  hostInfo.set(host, info);
  return info;
}

export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/** 包装生成的 POSIX 脚本，无论远端登录 shell 是什么都交给 `sh` 运行。 */
export function sh(script: string): string {
  return `sh -c ${shQuote(script)}`;
}
