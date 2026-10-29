import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  clampTimeout, Gate, KILL_GRACE_S, MAX_TIMEOUT_S, parseProbe, probeHost, remoteTimeoutWrap,
} from "../src/ssh.js";

// 给 probeHost 用的 ssh 是假的；下面 shell 层面的测试仍用真的 spawnSync。
const fakeSsh = vi.hoisted(() => ({ calls: [] as string[][], stdout: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (cmd: string, args: string[]) => {
      fakeSsh.calls.push([cmd, ...args]);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: () => true,
      });
      setTimeout(() => {
        child.stdout.end(fakeSsh.stdout);
        child.stderr.end();
        setTimeout(() => child.emit("close", 0), 5);
      }, 1);
      return child;
    },
  };
});

describe("parseProbe", () => {
  it("认 GNU 和 uutils 的 timeout，其余不认", () => {
    const timeout = (line: string) => parseProbe(line).timeout;
    expect(timeout("timeout (GNU coreutils) 9.1\n")).toBe(true);
    expect(timeout("timeout (uutils coreutils) 0.0.27\n")).toBe(true);
    expect(timeout("")).toBe(false); // busybox、cmd.exe，或者根本没有 timeout
    expect(timeout("timeout version 1.0\n")).toBe(false);
  });

  it("能把 Git Bash、MSYS2 和 Cygwin 主机与其他主机区分开", () => {
    const os = (name: string) => parseProbe(`timeout (GNU coreutils) 8.32\nos=${name}\n`).msys;
    expect(os("MINGW64_NT-10.0-22631")).toBe(true);
    expect(os("MSYS_NT-10.0")).toBe(true);
    expect(os("CYGWIN_NT-10.0")).toBe(true);
    expect(os("Linux")).toBe(false);
    expect(os("Darwin")).toBe(false);
  });

  it("从第一行判断是否支持 timeout，没有这一行也能解析", () => {
    expect(parseProbe("timeout (GNU coreutils) 8.32\nos=MINGW64_NT-10.0\n")).toEqual({ timeout: true, msys: true });
    expect(parseProbe("\nos=Darwin\n")).toEqual({ timeout: false, msys: false });
  });
});

describe("probeHost", () => {
  it("每台主机只探测一次，结果缓存下来", async () => {
    fakeSsh.calls.length = 0;
    fakeSsh.stdout = "timeout (GNU coreutils) 8.32\nos=MINGW64_NT-10.0-22631\n";
    expect(await probeHost("probe-once")).toEqual({ timeout: true, msys: true });
    expect(await probeHost("probe-once")).toEqual({ timeout: true, msys: true });
    expect(fakeSsh.calls).toHaveLength(1);
    expect(fakeSsh.calls[0].at(-1)).toContain("uname -s");
  });
});

describe("clampTimeout", () => {
  it("默认 60，并限制在 1..MAX_TIMEOUT_S 之间", () => {
    expect(clampTimeout()).toBe(60);
    expect(clampTimeout(0)).toBe(1);
    expect(clampTimeout(1800)).toBe(1800);
    expect(clampTimeout(99999)).toBe(MAX_TIMEOUT_S);
  });
});

describe("remoteTimeoutWrap", () => {
  // 用一个假的 `timeout` 代替 coreutils：记下收到的选项，再运行后面的命令。
  const bin = mkdtempSync(join(tmpdir(), "ssh-mcp-timeout-"));
  writeFileSync(join(bin, "timeout"), '#!/bin/sh\necho "timeout-args: $1 $2 $3" >&2\nshift 3\nexec "$@"\n');
  chmodSync(join(bin, "timeout"), 0o755);
  // 主机的登录 shell 收到包装后的字符串，和 sshd 传过去的一样。
  const login = (cmd: string, input = "") =>
    spawnSync("/bin/sh", ["-c", cmd], {
      input,
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, SHELL: "/bin/sh" },
    });

  it("把时限交给 timeout，命令原样传过去", () => {
    const cmd = `printf '%s|' "a b" 'it'"'"'s' "$((2+3))" \`echo tick\`; echo; exit 3`;
    const direct = login(cmd);
    const wrapped = login(remoteTimeoutWrap(cmd, 7));
    expect(wrapped.stdout).toBe(direct.stdout);
    expect(wrapped.stdout).toBe("a b|it's|5|tick|\n");
    expect(wrapped.status).toBe(3);
    expect(wrapped.stderr).toContain(`timeout-args: -k ${KILL_GRACE_S} 7`);
  });

  it("标准输入照常传给命令", () => {
    expect(login(remoteTimeoutWrap("cat", 5), "from stdin\n").stdout).toBe("from stdin\n");
  });

  it("非 MSYS 主机上照旧用 $SHELL 运行命令", () => {
    expect(remoteTimeoutWrap("uptime", 7)).toBe(`sh -c 'exec timeout -k 5 "$0" "\${SHELL:-sh}" -c "$1"' 7 'uptime'`);
  });

  it("MSYS 主机上用 MSYS 自己的 bash，先 TERM，5 秒后 KILL", () => {
    const wrapped = remoteTimeoutWrap("uptime", 7, true);
    expect(wrapped).toBe(`sh -c 'timeout -k 5 "$0" /usr/bin/bash -c "$1"; exit $?' 7 'uptime'`);
    expect(wrapped).not.toContain("SHELL");
  });

  it.skipIf(!existsSync("/usr/bin/bash"))("MSYS 主机上命令也原样传过去", () => {
    const cmd = `printf '%s|' "a b" "$((2+3))"; echo; exit 4`;
    const r = login(remoteTimeoutWrap(cmd, 7, true), "");
    expect(r.stdout).toBe("a b|5|\n");
    expect(r.status).toBe(4);
    expect(r.stderr).toContain(`timeout-args: -k ${KILL_GRACE_S} 7`);
  });
});

describe("Gate", () => {
  it("最多放 max 个进入，按顺序唤醒排队者", async () => {
    const gate = new Gate(2);
    let inside = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4].map(async (i) => {
        await gate.enter();
        inside++;
        peak = Math.max(peak, inside);
        order.push(i);
        await new Promise((r) => setTimeout(r, 5));
        inside--;
        gate.leave();
      }),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});
