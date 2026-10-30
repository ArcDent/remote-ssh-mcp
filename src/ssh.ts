import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_S = 60;
/** Cursor 对一次工具调用最多等 60 分钟，期间有进度通知也不例外。 */
export const MAX_TIMEOUT_S = 3600;
/** 远端 `timeout` 发出 TERM 后，再等多少秒发 KILL。 */
export const KILL_GRACE_S = 5;
/** 命令运行期间发进度的间隔；Cursor 120 秒收不到进度就会丢弃这次调用。 */
const PROGRESS_INTERVAL_MS = 10_000;

/** 每次调用都加的选项：同一主机复用一条连接，从不交互询问，连不上就尽快失败。 */
const SSH_OPTIONS = [
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${join(homedir(), ".ssh", "mcp-cm-%C")}`,
  "-o", "ControlPersist=10m",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-T",
];

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
  stdin?: string;
  /** 本机 ssh 客户端过了 timeoutS 后还能多跑几秒，再被杀掉。 */
  graceS?: number;
  signal?: AbortSignal;
  /** 每隔 PROGRESS_INTERVAL_MS 调用一次，参数是已经过去的秒数。 */
  onTick?: (elapsedS: number) => void;
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
    const child = spawn("ssh", [...SSH_OPTIONS, "--", host, remoteCmd], {
      stdio: ["pipe", "pipe", "pipe"],
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

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");

    child.on("error", (e) => finish(null, String(e)));
    child.on("close", (code) => finish(code));
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
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
   * 穿不过去的原生启动器（见 remoteTimeoutWrap）；会话关闭时 Win32-OpenSSH 会停掉会话启动的进程，
   * 加不加 nohup 都一样（见 jobStartScript）。
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
 * 返回 `host` 的 HostInfo，每台主机只探测一次。连不上主机时探测结果不缓存，放在 `failure` 里返回。
 */
export async function probeHost(host: string): Promise<HostInfo & { failure?: SshResult }> {
  const cached = hostInfo.get(host);
  if (cached) return cached;
  const probe = 'timeout --version 2>/dev/null | head -n 1; echo "os=$(uname -s 2>/dev/null)"';
  const r = await runSsh(host, sh(probe), { timeoutS: 15 });
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
