import { randomBytes } from "node:crypto";
import { shQuote } from "./ssh.js";

/**
 * 后台任务放在主机的 $HOME/.mcp-jobs/<id>/ 下：cmd、stdin、pid、start（启动时刻，epoch 秒）、
 * out.log（标准输出和标准错误），任务结束后再写 exit。已结束超过 JOB_KEEP_DAYS 天的任务，
 * 在下次启动后台任务时删除。
 */
export const JOB_ID = /^j\d{8}-\d{6}-[0-9a-f]{4}$/;
const JOB_KEEP_DAYS = 7;
const LOG_LINES = 200;

export function newJobId(now = new Date()): string {
  const t = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `j${t.slice(0, 8)}-${t.slice(8)}-${randomBytes(2).toString("hex")}`;
}

/**
 * 由 WMI 启动任务：这样创建的进程不属于任何 ssh 会话，会话关闭时 Win32-OpenSSH 不会停掉它。
 * 它启动时几乎没有环境变量，所以 `run.sh` 先从 `env` 文件读回 PATH 和工作目录。记下的 pid 是
 * Windows 进程号，因为会话里的 MSYS 进程表看不到这个任务。
 */
const MSYS_START = `printf '%s\\n%s\\n' "$PATH" "$PWD" > "$d/env"
cat > "$d/run.sh" <<'EOF'
cd "$1" || exit 1
{ IFS= read -r PATH; IFS= read -r W; } < env
export PATH
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
 */
export function jobStartScript(id: string, cmd: string, msys = false): string {
  const prepare = `root="$HOME/.mcp-jobs"; d="$root/${id}"
mkdir -p "$root"
find "$root" -mindepth 2 -maxdepth 2 -name exit -mtime +${JOB_KEEP_DAYS} 2>/dev/null | while read -r f; do rm -rf "\${f%/exit}"; done
mkdir "$d"
cat > "$d/stdin"
printf '%s\\n' ${shQuote(cmd)} > "$d/cmd"
date +%s > "$d/start"`;
  const check = `echo "check with exec job=${id}; add timeout to wait for it to finish"`;
  if (msys) return `set -e\n${prepare}\n${MSYS_START}\necho "job=${id} started (Windows pid $w)"\n${check}`;
  return `set -e
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*)
  cat >/dev/null
  echo "background is not supported on Windows hosts: processes started by the ssh session stop when it ends. Run cmd in the foreground with a timeout." >&2
  exit 2;;
esac
${prepare}
S=; command -v setsid >/dev/null 2>&1 && S=setsid
nohup $S sh -c '"\${SHELL:-sh}" -c "$2" < "$1/stdin" > "$1/out.log" 2>&1; echo $? > "$1/exit.tmp"; mv "$1/exit.tmp" "$1/exit"' sh "$d" ${shQuote(cmd)} </dev/null >/dev/null 2>&1 &
echo $! > "$d/pid"
echo "job=${id} started (pid $!)"
${check}`;
}

/**
 * 先最多等 `waitS` 秒让任务结束，再报告任务状态和日志末尾。MSYS 主机上由 WMI 启动的任务按
 * Windows 进程号查找。
 */
export function jobStatusScript(id: string, waitS: number, msys = false): string {
  const alive = msys
    ? `p=$(cat "$d/pid" 2>/dev/null); [ -n "$p" ] && tasklist //FI "PID eq $p" //FI "IMAGENAME eq sh.exe" //NH //FO CSV 2>/dev/null | grep -q "\\"$p\\""`
    : `kill -0 "$(cat "$d/pid" 2>/dev/null)" 2>/dev/null`;
  return `d="$HOME/.mcp-jobs/${id}"
[ -d "$d" ] || { echo "no such job: ${id}" >&2; exit 2; }
end=$(( $(date +%s) + ${waitS} ))
while [ ! -f "$d/exit" ] && [ "$(date +%s)" -lt "$end" ]; do sleep 1; done
el=$(( $(date +%s) - $(cat "$d/start") ))
if [ -f "$d/exit" ]; then
  ran=$(( $(stat -c %Y "$d/exit" 2>/dev/null || date +%s) - $(cat "$d/start") ))
  echo "job=${id} state=done exit=$(cat "$d/exit") ran=\${ran}s"
elif ${alive}; then echo "job=${id} state=running pid=$(cat "$d/pid") elapsed=\${el}s"
else echo "job=${id} state=lost (process gone without an exit code) elapsed=\${el}s"; fi
echo "== log (last ${LOG_LINES} lines)"
tail -n ${LOG_LINES} "$d/out.log" 2>/dev/null`;
}
