import { randomBytes } from "node:crypto";
import { KILL_GRACE_S, shQuote } from "./ssh.js";

/**
 * 后台任务放在主机的 $HOME/.mcp-jobs/<id>/ 下：cmd、stdin、pid、pgid（任务的进程组号，记得下时才有）、
 * start（启动时刻，epoch 秒）、out.log（标准输出和标准错误），任务结束后再写 exit；被 kill 停掉的
 * 任务还有 killed（停掉它的信号）。已结束超过 JOB_KEEP_DAYS 天的任务，在下次启动后台任务时删除。
 */
export const JOB_ID = /^j\d{8}-\d{6}-[0-9a-f]{4}$/;
const JOB_KEEP_DAYS = 7;
const LOG_LINES = 200;
/** list 最多列出几个任务，以及每个任务显示命令的前几个字符。 */
const LIST_MAX = 30;
const CMD_CHARS = 60;

export function newJobId(now = new Date()): string {
  const t = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `j${t.slice(0, 8)}-${t.slice(8)}-${randomBytes(2).toString("hex")}`;
}

/**
 * 由 WMI 启动任务：这样创建的进程不属于任何 ssh 会话，会话关闭时 Win32-OpenSSH 不会停掉它。
 * 它启动时几乎没有环境变量，所以 `run.sh` 先从 `env` 文件读回 PATH 和工作目录。记下的 pid 是
 * Windows 进程号，因为会话里的 MSYS 进程表看不到这个任务。`run.sh` 另外记下自己在 MSYS 里的
 * 进程组号：MSYS 启动程序时会断开子进程在 Windows 里的父子关系，taskkill /T 找不到子进程。
 */
const MSYS_START = `printf '%s\\n%s\\n' "$PATH" "$PWD" > "$d/env"
cat > "$d/run.sh" <<'EOF'
cd "$1" || exit 1
{ IFS= read -r PATH; IFS= read -r W; } < env
export PATH
g=$(cat /proc/$$/pgid 2>/dev/null) && echo "$g" > pgid
cd "$W" || cd
bash -c "$(cat "$1/cmd")" < "$1/stdin" > "$1/out.log" 2>&1
echo $? > "$1/exit.tmp"; mv "$1/exit.tmp" "$1/exit"
EOF
o=$(B=$(cygpath -w /usr/bin/sh) R=$(cygpath -w "$d/run.sh") D=$d powershell.exe -NoProfile -NonInteractive -Command '$q = [char]34; $a = @($env:B, $env:R, $env:D) | ForEach-Object { $q + $_ + $q }; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $a -join [char]32 }; if ($r.ReturnValue -ne 0) { exit 1 }; $r.ProcessId' </dev/null) ||
  { echo "could not start the job through WMI" >&2; exit 1; }
w=$(printf %s "$o" | tr -dc 0-9)
echo "$w" > "$d/pid"`;

/**
 * 让 `cmd` 脱离 ssh 会话启动，调用立即返回，连接断开后任务照常运行；工具收到的标准输入就是任务
 * 的标准输入。一般主机上用 setsid（有的话）加 nohup，输入输出全部接到文件。MSYS 主机（见
 * HostInfo）上，会话结束时 Win32-OpenSSH 会停掉会话启动的进程，加不加 nohup 都一样，所以改由
 * WMI 启动；探测没认出来的 Windows 主机，由脚本里的 uname 检查拒绝。
 *
 * kill 按进程组停任务。有 setsid 时任务自成一组，组号就是 pid。没有 setsid 时（如 macOS）任务留在
 * 启动脚本所在的组里：sshd 给每个会话新开一组，组长是登录 shell，也就是启动脚本自己或它的父进程，
 * 这一组里只剩这个任务；组长不是这两者时不记组号，免得 kill 停到别的进程。
 */
export function jobStartScript(id: string, cmd: string, msys = false): string {
  const prepare = `root="$HOME/.mcp-jobs"; d="$root/${id}"
mkdir -p "$root"
find "$root" -mindepth 2 -maxdepth 2 -name exit -mtime +${JOB_KEEP_DAYS} 2>/dev/null | while read -r f; do rm -rf "\${f%/exit}"; done
mkdir "$d"
cat > "$d/stdin"
printf '%s\\n' ${shQuote(cmd)} > "$d/cmd"
date +%s > "$d/start"`;
  const check = `echo "check with job action=status id=${id}; add timeout to wait for it to finish"`;
  if (msys) return `set -e\n${prepare}\n${MSYS_START}\necho "job=${id} started (Windows pid $w)"\n${check}`;
  return `set -e
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*)
  cat >/dev/null
  echo "background jobs are not supported on Windows hosts: processes started by the ssh session stop when it ends. Run cmd in the foreground with a timeout." >&2
  exit 2;;
esac
${prepare}
S=; command -v setsid >/dev/null 2>&1 && S=setsid
nohup $S sh -c '"\${SHELL:-sh}" -c "$2" < "$1/stdin" > "$1/out.log" 2>&1; echo $? > "$1/exit.tmp"; mv "$1/exit.tmp" "$1/exit"' sh "$d" ${shQuote(cmd)} </dev/null >/dev/null 2>&1 &
p=$!
echo $p > "$d/pid"
if [ -n "$S" ]; then echo $p > "$d/pgid"
else
  g=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  if [ "$g" = $$ ] || [ "$g" = "$PPID" ]; then echo "$g" > "$d/pgid"; fi
fi
echo "job=${id} started (pid $p)"
${check}`;
}

/**
 * 各脚本共用的函数：`mt` 取文件修改时刻（GNU、busybox 用 stat -c，macOS 用 stat -f），`alive`
 * 判断任务主进程还在不在，`state` 给出任务状态。MSYS 主机上由 WMI 启动的任务按 Windows 进程号查找。
 */
function helpers(msys: boolean): string {
  const alive = msys
    ? `_p=$(cat "$1/pid" 2>/dev/null); [ -n "$_p" ] && tasklist //FI "PID eq $_p" //FI "IMAGENAME eq sh.exe" //NH //FO CSV 2>/dev/null | grep -q "\\"$_p\\""`
    : `kill -0 "$(cat "$1/pid" 2>/dev/null)" 2>/dev/null`;
  return `mt() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || date +%s; }
alive() { ${alive}; }
state() {
  if [ -f "$1/exit" ]; then if [ -f "$1/killed" ]; then echo killed; else echo done; fi
  elif alive "$1"; then echo running; else echo lost; fi
}`;
}

function jobDir(id: string): string {
  return `d="$HOME/.mcp-jobs/${id}"
[ -d "$d" ] || { echo "no such job: ${id}" >&2; exit 2; }`;
}

/**
 * 先最多等 `waitS` 秒让任务结束，再报告任务状态和日志末尾。
 */
export function jobStatusScript(id: string, waitS: number, msys = false): string {
  return `${jobDir(id)}
${helpers(msys)}
end=$(( $(date +%s) + ${waitS} ))
while [ ! -f "$d/exit" ] && [ "$(date +%s)" -lt "$end" ]; do sleep 1; done
st=$(cat "$d/start")
case $(state "$d") in
  done) echo "job=${id} state=done exit=$(cat "$d/exit") ran=$(( $(mt "$d/exit") - st ))s";;
  killed) echo "job=${id} state=killed exit=$(cat "$d/exit") signal=$(cat "$d/killed") ran=$(( $(mt "$d/exit") - st ))s";;
  running) echo "job=${id} state=running pid=$(cat "$d/pid") elapsed=$(( $(date +%s) - st ))s";;
  *) echo "job=${id} state=lost (process gone without an exit code) elapsed=$(( $(date +%s) - st ))s";;
esac
echo "== log (last ${LOG_LINES} lines)"
tail -n ${LOG_LINES} "$d/out.log" 2>/dev/null`;
}

/**
 * 停掉任务和它启动的子进程：先对整组进程发 TERM，KILL_GRACE_S 秒后还在就发 KILL；没记下组号的
 * 任务只停主进程。之后写下 killed 和退出码（143 或 137），状态显示为 killed。MSYS 主机上按 MSYS
 * 的进程组发信号，主进程（Windows 进程号）还在就再用 taskkill 强制停掉；没记下组号的旧任务只能
 * 这样停，退出码记 137。已结束或已丢失的任务不发信号。
 */
export function jobKillScript(id: string, msys = false): string {
  const stop = msys
    ? `g=$(cat "$d/pgid" 2>/dev/null || true); k=KILL; c=137
if [ -n "$g" ]; then
  kill -TERM -"$g" 2>/dev/null; n=0
  while kill -0 -"$g" 2>/dev/null && [ $n -lt ${KILL_GRACE_S} ]; do sleep 1; n=$((n+1)); done
  if kill -0 -"$g" 2>/dev/null; then kill -KILL -"$g" 2>/dev/null; else k=TERM; c=143; fi
fi
alive "$d" && { taskkill //PID "$(cat "$d/pid")" //T //F >/dev/null 2>&1 || true; }
n=0; while alive "$d" && [ $n -lt ${KILL_GRACE_S} ]; do sleep 1; n=$((n+1)); done
alive "$d" && { echo "could not stop job=${id} (Windows pid $(cat "$d/pid"))" >&2; exit 1; }`
    : `p=$(cat "$d/pid"); g=$(cat "$d/pgid" 2>/dev/null || true)
up() { if [ -n "$g" ]; then kill -0 -"$g" 2>/dev/null; else kill -0 "$p" 2>/dev/null; fi; }
sig() { if [ -n "$g" ]; then kill -"$1" -"$g" 2>/dev/null; else kill -"$1" "$p" 2>/dev/null; fi; }
sig TERM; n=0
while up && [ $n -lt ${KILL_GRACE_S} ]; do sleep 1; n=$((n+1)); done
if up; then sig KILL; k=KILL; c=137; else k=TERM; c=143; fi`;
  return `${jobDir(id)}
${helpers(msys)}
case $(state "$d") in
  done|killed) echo "job=${id} already ended: state=$(state "$d") exit=$(cat "$d/exit")"; exit 0;;
  lost) echo "job=${id} state=lost (process gone without an exit code); nothing to stop"; exit 0;;
esac
${stop}
echo $k > "$d/killed"
[ -f "$d/exit" ] || echo $c > "$d/exit"
echo "job=${id} stopped with $k: state=killed exit=$(cat "$d/exit")"`;
}

/**
 * 列出主机上的任务，新的在前，最多 LIST_MAX 个。第一行是 `now=<epoch> total=<任务数>`，之后每个
 * 任务一行，以制表符分隔：任务号、状态、退出码、启动时刻、结束时刻、命令开头（换行改成空格）。
 * 由 formatJobList 排版。
 */
export function jobListScript(msys = false): string {
  return `root="$HOME/.mcp-jobs"
${helpers(msys)}
ids=$(ls -1 "$root" 2>/dev/null | grep -E '^j[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$' | sort -r)
echo "now=$(date +%s) total=$(printf '%s' "$ids" | grep -c .)"
for id in $(printf '%s\\n' "$ids" | head -n ${LIST_MAX}); do
  d="$root/$id"; e=; t=
  if [ -f "$d/exit" ]; then e=$(cat "$d/exit"); t=$(mt "$d/exit"); fi
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$(state "$d")" "$e" "$(cat "$d/start" 2>/dev/null)" "$t" "$(head -c 400 "$d/cmd" 2>/dev/null | tr '\\n\\t' '  ')"
done`;
}

/** 秒数写成 45s、3m05s、2h10m、3d4h 这样。 */
function duration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "?";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

/** 把 jobListScript 的输出排成每个任务一行：任务号、状态、退出码和用时、多久前启动、命令开头。 */
export function formatJobList(out: string): string {
  const [head = "", ...rows] = out.split("\n").filter(Boolean);
  const now = Number(/now=(\d+)/.exec(head)?.[1]);
  const total = Number(/total=(\d+)/.exec(head)?.[1] ?? 0);
  if (!total) return "这台主机上没有后台任务";
  const lines = rows.map((row) => {
    const [id, state, exit, start, end, ...rest] = row.split("\t");
    const cmd = Array.from(rest.join(" ").trim());
    const shown = cmd.length > CMD_CHARS ? `${cmd.slice(0, CMD_CHARS).join("")}…` : cmd.join("");
    const parts = [id, `state=${state}`];
    if (exit) parts.push(`exit=${exit}`, `ran=${duration(Number(end) - Number(start))}`);
    parts.push(`started=${start ? `${duration(now - Number(start))} ago` : "?"}`);
    return `${parts.join(" ")}  ${shown}`;
  });
  if (total > rows.length) lines.unshift(`共 ${total} 个任务，只列出最新的 ${rows.length} 个`);
  return lines.join("\n");
}
