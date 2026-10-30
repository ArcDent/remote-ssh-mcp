import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatJobList, JOB_ID, jobKillScript, jobListScript, jobStartScript, jobStatusScript, newJobId,
} from "../src/jobs.js";

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
    expect(jobStatusScript("j20260101-000000-0000", 0)).toContain('kill -0 "$(cat "$1/pid" 2>/dev/null)"');
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

describe("停止和列出后台任务", () => {
  const home = mkdtempSync(join(tmpdir(), "ssh-mcp-kill-"));
  const env = { ...process.env, HOME: home, SHELL: "/bin/sh" };
  const sh = (script: string) => spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env });
  // 像 sshd 那样让启动脚本自成一个会话；不这样的话任务和测试进程同在一组，kill 会停到测试自己。
  const start = (id: string, cmd: string) =>
    new Promise<string>((resolve) => {
      const c = spawn("/bin/sh", ["-c", jobStartScript(id, cmd)], { detached: true, env });
      let out = "";
      c.stdout.on("data", (d: Buffer) => (out += d));
      c.on("close", () => resolve(out));
      c.stdin.end();
    });
  const running = (pattern: string) => spawnSync("pgrep", ["-f", pattern]).status === 0;

  it("对整组进程发 TERM，子进程一起停掉", async () => {
    const id = newJobId();
    await start(id, "sleep 37 & sleep 37");
    expect(running("sleep 37")).toBe(true);
    expect(existsSync(join(home, ".mcp-jobs", id, "pgid"))).toBe(true);
    const t = Date.now();
    const r = sh(jobKillScript(id));
    expect(Date.now() - t).toBeLessThan(7000);
    expect(r.stdout).toContain("stopped with TERM");
    expect(sh(jobStatusScript(id, 0)).stdout).toContain("state=killed exit=143");
    expect(running("sleep 37")).toBe(false);
  });

  it("忽略 TERM 的任务等宽限过后发 KILL", async () => {
    const id = newJobId();
    await start(id, "trap '' TERM; sleep 38");
    const r = sh(jobKillScript(id));
    expect(r.stdout).toContain("stopped with KILL");
    expect(sh(jobStatusScript(id, 0)).stdout).toContain("state=killed exit=137");
    expect(running("sleep 38")).toBe(false);
  }, 15000);

  it("已结束的任务不发信号，状态不变", async () => {
    const id = newJobId();
    await start(id, "exit 3");
    expect(sh(jobStatusScript(id, 5)).stdout).toContain("state=done exit=3");
    expect(sh(jobKillScript(id)).stdout).toContain("already ended: state=done exit=3");
    expect(sh(jobStatusScript(id, 0)).stdout).toContain("state=done exit=3");
  });

  it("任务不存在时 kill 如实报告", () => {
    const r = sh(jobKillScript("j20260101-000000-0000"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no such job");
  });

  it("列出任务：新的在前，命令只显示前 60 个字符，最多 30 个", async () => {
    const home2 = mkdtempSync(join(tmpdir(), "ssh-mcp-list-"));
    const list = () =>
      formatJobList(spawnSync("/bin/sh", ["-c", jobListScript()], { encoding: "utf8", env: { ...env, HOME: home2 } }).stdout);
    expect(list()).toBe("这台主机上没有后台任务");
    const ids = [0, 1, 2].map((s) => newJobId(new Date(Date.UTC(2026, 9, 29, 1, 0, s))));
    const long = `echo ${"x".repeat(95)}`;
    for (const [i, cmd] of ["exit 3", "sleep 39", long].entries()) {
      const c = spawn("/bin/sh", ["-c", jobStartScript(ids[i], cmd)], { detached: true, env: { ...env, HOME: home2 } });
      c.stdin.end();
      await new Promise((r) => c.on("close", r));
    }
    spawnSync("/bin/sh", ["-c", jobStatusScript(ids[0], 5)], { env: { ...env, HOME: home2 } });
    const lines = list().split("\n");
    expect(lines.map((l) => l.split(" ")[0])).toEqual([ids[2], ids[1], ids[0]]);
    expect(lines[1]).toMatch(/state=running started=\d+s ago {2}sleep 39$/);
    expect(lines[2]).toMatch(/state=done exit=3 ran=\d+s started=\d+s ago {2}exit 3$/);
    expect(lines[0].endsWith(`  ${long.slice(0, 60)}…`)).toBe(true);
    spawnSync("/bin/sh", ["-c", jobKillScript(ids[1])], { env: { ...env, HOME: home2 } });

    for (let i = 0; i < 32; i++) {
      const d = join(home2, ".mcp-jobs", newJobId(new Date(Date.UTC(2026, 9, 28, 0, 0, i))));
      mkdirSync(d);
      writeFileSync(join(d, "start"), "1792000000\n");
      writeFileSync(join(d, "cmd"), "true\n");
    }
    const many = list().split("\n");
    expect(many[0]).toBe("共 35 个任务，只列出最新的 30 个");
    expect(many).toHaveLength(31);
    expect(many[30]).toContain("state=lost");
  });

  it("MSYS 主机上用 taskkill 停掉整棵进程树", () => {
    const bin = mkdtempSync(join(tmpdir(), "ssh-mcp-taskkill-"));
    writeFileSync(join(bin, "cygpath"), '#!/bin/sh\n[ "$1" = -w ] && shift\nprintf "%s\\n" "$1"\n', { mode: 0o755 });
    writeFileSync(join(bin, "powershell.exe"), '#!/bin/sh\nsh "$R" "$D" </dev/null >/dev/null 2>&1 &\necho "$!"\n', { mode: 0o755 });
    writeFileSync(
      join(bin, "tasklist"),
      '#!/bin/sh\nfor a; do case $a in "PID eq "*) p=${a#PID eq };; esac; done\nkill -0 "$p" 2>/dev/null && echo "\\"sh.exe\\",\\"$p\\""\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "taskkill"), '#!/bin/sh\necho "$@" > "$HOME/taskkill.args"\nkill -9 "$2"\n', { mode: 0o755 });
    const run = (script: string) =>
      spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { ...env, PATH: `${bin}:${process.env.PATH}` } });
    const id = newJobId();
    const started = run(jobStartScript(id, "sleep 3", true)).stdout;
    const pid = /Windows pid (\d+)/.exec(started)![1];
    expect(run(jobKillScript(id, true)).stdout).toContain("stopped with KILL");
    expect(readFileSync(join(home, "taskkill.args"), "utf8").trim()).toBe(`//PID ${pid} //T //F`);
    expect(run(jobStatusScript(id, 0, true)).stdout).toContain("state=killed exit=137");
  });
});
