import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JOB_ID, jobStartScript, jobStatusScript, newJobId } from "../src/jobs.js";

describe("newJobId", () => {
  it("符合 JOB_ID 格式，并带有 UTC 时间", () => {
    const id = newJobId(new Date("2026-10-29T04:13:07Z"));
    expect(id).toMatch(JOB_ID);
    expect(id.startsWith("j20261029-041307-")).toBe(true);
  });
});

describe("后台任务脚本", () => {
  // 用临时 HOME 运行脚本，模拟主机的登录 shell。
  const home = mkdtempSync(join(tmpdir(), "ssh-mcp-jobs-"));
  const sh = (script: string, input = "") =>
    spawnSync("/bin/sh", ["-c", script], { input, encoding: "utf8", env: { ...process.env, HOME: home, SHELL: "/bin/sh" } });

  it("脱离会话运行任务并传入标准输入，能报告状态、退出码和日志", () => {
    const id = newJobId();
    const started = sh(jobStartScript(id, `read -r x; echo "got $x"; sleep 1; exit 3`), "hello\n");
    expect(started.status).toBe(0);
    expect(started.stdout).toContain(`job=${id} started`);
    expect(sh(jobStatusScript(id, 0)).stdout).toContain("state=running");
    const done = sh(jobStatusScript(id, 10)).stdout;
    expect(done).toContain("state=done exit=3");
    expect(done).toContain("got hello");
  });

  it("在 Windows（Git Bash、MSYS、Cygwin）上拒绝启动", () => {
    const bin = mkdtempSync(join(tmpdir(), "ssh-mcp-uname-"));
    writeFileSync(join(bin, "uname"), "#!/bin/sh\necho MINGW64_NT-10.0-22631\n", { mode: 0o755 });
    const id = newJobId();
    const r = spawnSync("/bin/sh", ["-c", jobStartScript(id, "true")], {
      input: "data\n",
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not supported on Windows hosts");
    expect(existsSync(join(home, ".mcp-jobs", id))).toBe(false);
  });

  it("MSYS 主机上经 WMI 启动任务，并按 Windows 进程号找到它", () => {
    // 模拟 Windows 一侧：cygpath 原样返回路径，powershell.exe 像 Win32_Process.Create 那样启动
    // run.sh 并打印 pid，tasklist 在进程运行期间列出这个 pid。
    const bin = mkdtempSync(join(tmpdir(), "ssh-mcp-wmi-"));
    writeFileSync(join(bin, "cygpath"), '#!/bin/sh\n[ "$1" = -w ] && shift\nprintf "%s\\n" "$1"\n', { mode: 0o755 });
    writeFileSync(join(bin, "powershell.exe"), '#!/bin/sh\nsh "$R" "$D" </dev/null >/dev/null 2>&1 &\necho "$!"\n', { mode: 0o755 });
    writeFileSync(
      join(bin, "tasklist"),
      '#!/bin/sh\nfor a; do case $a in "PID eq "*) p=${a#PID eq };; esac; done\nkill -0 "$p" 2>/dev/null && echo "\\"sh.exe\\",\\"$p\\""\nexit 0\n',
      { mode: 0o755 },
    );
    const run = (script: string, input = "") =>
      spawnSync("/bin/sh", ["-c", script], { input, encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    const id = newJobId();
    const started = run(jobStartScript(id, `read -r x; echo "got $x"; sleep 1; echo 中文; exit 7`, true), "hi\n");
    expect(started.status).toBe(0);
    expect(started.stdout).toMatch(new RegExp(`job=${id} started \\(Windows pid \\d+\\)`));
    expect(run(jobStatusScript(id, 0, true)).stdout).toContain("state=running");
    const done = run(jobStatusScript(id, 10, true)).stdout;
    expect(done).toContain("state=done exit=7");
    expect(done).toContain("got hi");
    expect(done).toContain("中文");
  });

  it("非 MSYS 主机的脚本仍用 nohup 和 kill -0", () => {
    expect(jobStartScript("j20260101-000000-0000", "true")).toContain("nohup $S sh -c");
    expect(jobStartScript("j20260101-000000-0000", "true")).not.toContain("Invoke-CimMethod");
    expect(jobStatusScript("j20260101-000000-0000", 0)).toContain('kill -0 "$(cat "$d/pid" 2>/dev/null)"');
  });

  it("任务不存在时如实报告", () => {
    const r = sh(jobStatusScript("j20260101-000000-0000", 0));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no such job");
  });

  it("启动新任务时删除超过保留期的已结束任务", () => {
    sh(`mkdir -p "$HOME/.mcp-jobs/old" && touch "$HOME/.mcp-jobs/old/exit" && touch -t 202601010000 "$HOME/.mcp-jobs/old/exit"`);
    sh(jobStartScript(newJobId(), "true"));
    expect(readdirSync(join(home, ".mcp-jobs"))).not.toContain("old");
  });
});
