import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  clampTimeout, connArgs, Gate, KILL_GRACE_S, MAX_TIMEOUT_S, parseProbe, probeHost, remoteTimeoutWrap, runSsh, sudoWrap,
  Tap,
} from "../src/ssh.js";

// 给 probeHost、runSsh 用的 ssh 是假的；下面 shell 层面的测试仍用真的 spawnSync。假 ssh 依次输出 queue 里的
// 内容（空了就用 stdout），把收到的标准输入记进 stdins；拿到 askpass 时连问两次密码，记下每次的输出。
const fakeSsh = vi.hoisted(() => ({
  calls: [] as string[][],
  envs: [] as (NodeJS.ProcessEnv | undefined)[],
  askpass: [] as { status: number | null; stdout: string }[],
  stdins: [] as Promise<Buffer>[],
  queue: [] as (string | Buffer)[],
  stdout: "",
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      fakeSsh.calls.push([cmd, ...args]);
      fakeSsh.envs.push(opts?.env);
      const askpass = opts?.env?.SSH_ASKPASS;
      if (askpass) {
        for (let i = 0; i < 2; i++) fakeSsh.askpass.push(real.spawnSync(askpass, { env: opts.env, encoding: "utf8" }));
      }
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: () => true,
      });
      const got: Buffer[] = [];
      child.stdin.on("data", (d: Buffer) => got.push(d));
      fakeSsh.stdins.push(new Promise((resolve) => child.stdin.on("end", () => resolve(Buffer.concat(got)))));
      const out = fakeSsh.queue.shift() ?? fakeSsh.stdout;
      // 和真的子进程一样，标准输出读完才发 close。
      child.stdout.on("end", () => setTimeout(() => child.emit("close", 0), 5));
      setTimeout(() => {
        child.stdout.end(out);
        child.stderr.end();
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

describe("connArgs", () => {
  // 临时的 ssh config 和 known_hosts；主机密钥用 ssh-keygen 现生成一把。
  const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-conn-"));
  const kh = join(dir, "known_hosts");
  const config = join(dir, "config");
  const key = join(dir, "id");
  writeFileSync(kh, "");
  writeFileSync(
    config,
    ["Host t", "  HostName 10.9.8.7", "  Port 2222", `  UserKnownHostsFile ${kh}`, "  GlobalKnownHostsFile /dev/null", "Host j"].join(
      "\n",
    ),
  );
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);

  it("每个字段生成对应的 ssh 选项，且不复用已有连接", () => {
    const { args, password } = connArgs("t", { port: 2200, user: "root", identity: key, jump: "j" }, config);
    expect(args.slice(0, 4)).toEqual(["-o", "ControlMaster=no", "-o", "ControlPath=none"]);
    const line = args.join(" ");
    for (const part of ["-J j", "-p 2200", "-l root", `-i ${key} -o IdentitiesOnly=yes`]) expect(line).toContain(part);
    expect(password).toBeUndefined();
  });

  it("跳板不是别名、密钥文件不存在时拒绝", () => {
    expect(() => connArgs("t", { jump: "10.0.0.1" }, config)).toThrow(/未知主机「10\.0\.0\.1」/);
    expect(() => connArgs("t", { identity: join(dir, "none") }, config)).toThrow(/不是本机上的文件/);
  });

  it("改 HostName 时要求对端主机密钥和别名原来的记录一致，没有记录就拒绝", () => {
    expect(() => connArgs("t", { hostname: "100.64.0.2" }, config)).toThrow(/known_hosts 里没有「t」的主机密钥/);
    const pub = readFileSync(`${key}.pub`, "utf8").split(" ").slice(0, 2).join(" ");
    writeFileSync(kh, `[10.9.8.7]:2222 ${pub}\n`);
    expect(connArgs("t", { hostname: "100.64.0.2" }, config).args.join(" ")).toContain(
      "-o HostName=100.64.0.2 -o HostKeyAlias=[10.9.8.7]:2222 -o StrictHostKeyChecking=yes",
    );
  });

  it("带密码时开 askpass 登录，只试一次，第一次连接记下主机密钥", () => {
    const { args, password } = connArgs("t", { password: "pw" }, config);
    expect(password).toBe("pw");
    const line = args.join(" ");
    for (const part of ["BatchMode=no", "NumberOfPasswordPrompts=1", "StrictHostKeyChecking=accept-new"]) {
      expect(line).toContain(part);
    }
    expect(args).not.toContain("pw");
  });
});

describe("runSsh 带密码", () => {
  it("密码经 askpass 交给 ssh，只给一次，不进命令行，用完删掉 askpass", async () => {
    fakeSsh.calls.length = 0;
    fakeSsh.envs.length = 0;
    fakeSsh.askpass.length = 0;
    await runSsh("conn-pw", "true", { conn: { args: ["-o", "ControlPath=none"], password: "s3cret" } });
    expect(fakeSsh.calls[0].slice(0, 3)).toEqual(["ssh", "-o", "ControlPath=none"]);
    expect(fakeSsh.calls[0].join(" ")).not.toContain("s3cret");
    const env = fakeSsh.envs[0]!;
    expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(fakeSsh.askpass.map((r) => [r.status, r.stdout])).toEqual([[0, "s3cret\n"], [1, ""]]);
    expect(existsSync(env.SSH_ASKPASS!)).toBe(false);
  });
});

describe("runSsh 流式", () => {
  it("A 的标准输出边读边写进 B 的标准输入，字节数和 sha256 都对得上", async () => {
    const data = randomBytes(5_000_000);
    fakeSsh.stdins.length = 0;
    fakeSsh.queue.push(data, "");
    const tap = new Tap();
    await Promise.all([runSsh("pipe-a", "cat big", { stdout: tap }), runSsh("pipe-b", "sha256sum", { stdin: tap })]);
    const got = await fakeSsh.stdins[1];
    expect(got.equals(data)).toBe(true);
    expect(tap.bytes).toBe(5_000_000);
    expect(tap.sha256()).toBe(createHash("sha256").update(data).digest("hex"));
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

describe("sudoWrap", () => {
  // 假 sudo：FAKE_SUDO_PW 为空表示免密；否则 -n 时直接失败，-A 时最多问 askpass 3 次，对上才运行命令。
  // 真 sudo 运行命令前会清掉环境变量，这个不清，好检查命令里看不到密码变量。
  const bin = mkdtempSync(join(tmpdir(), "ssh-mcp-sudo-"));
  writeFileSync(
    join(bin, "sudo"),
    `#!/bin/sh
A=; while :; do case "$1" in -n|-H) shift;; -A) A=1; shift;; --) shift; break;; *) break;; esac; done
if [ -n "$FAKE_SUDO_PW" ]; then
  [ -n "$A" ] || { echo "sudo: a password is required" >&2; exit 1; }
  i=0; ok=
  while [ $i -lt 3 ]; do
    got=$("$SUDO_ASKPASS" "[sudo] password: ") || break
    i=$((i+1))
    [ "$got" = "$FAKE_SUDO_PW" ] && { ok=1; break; }
    echo "Sorry, try again." >&2
  done
  [ -n "$ok" ] || { echo "sudo: $i incorrect password attempt" >&2; exit 1; }
fi
exec "$@"
`,
  );
  chmodSync(join(bin, "sudo"), 0o755);
  writeFileSync(join(bin, "timeout"), '#!/bin/sh\nshift 3\nexec "$@"\n');
  chmodSync(join(bin, "timeout"), 0o755);
  const home = mkdtempSync(join(tmpdir(), "ssh-mcp-sudo-home-"));
  const login = (w: { cmd: string; stdin?: string }, needsPw = "") =>
    spawnSync("/bin/sh", ["-c", w.cmd], {
      input: w.stdin ?? "",
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, SHELL: "/bin/sh", HOME: home, FAKE_SUDO_PW: needsPw },
    });
  const cmd = `printf '%s|' "a b" 'it'"'"'s' "$((2+3))"; echo; exit 3`;

  it("免密时不传 pswd 也能跑，命令和退出码原样传过去", () => {
    const r = login(sudoWrap(cmd));
    expect(r.stdout).toBe("a b|it's|5|\n");
    expect(r.status).toBe(3);
  });

  it("要密码而没传 pswd 时直接失败，提示传 pswd", () => {
    const r = login(sudoWrap("echo ran"), "s3cret");
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pass pswd");
  });

  it("密码只在标准输入里，不进命令行，命令里也看不到密码变量", () => {
    const w = sudoWrap(`echo "pw=\${MCP_SUDO_PW-unset}"`, undefined, "s3cret");
    expect(w.cmd).not.toContain("s3cret");
    expect(w.stdin).toBe("s3cret\n");
    const r = login(w, "s3cret");
    expect(r.stdout).toBe("pw=unset\n");
    expect(r.status).toBe(0);
  });

  it("命令收到的标准输入和不带 sudo 时相同", () => {
    const input = "line1\n'quoted' $HOME\nno newline at end";
    expect(login({ cmd: "cat", stdin: input }).stdout).toBe(input);
    expect(login(sudoWrap("cat", input), "").stdout).toBe(input);
    expect(login(sudoWrap("cat", input, "s3cret"), "s3cret").stdout).toBe(input);
    expect(login(sudoWrap("cat", input, "s3cret"), "").stdout).toBe(input);
  });

  it("密码错时 askpass 只给一次，sudo 不再接着试", () => {
    const r = login(sudoWrap("echo ran", "x", "wrong"), "s3cret");
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("sudo: 1 incorrect password attempt");
  });

  it("跑完删掉临时的 askpass 目录", () => {
    login(sudoWrap("true", undefined, "s3cret"), "s3cret");
    login(sudoWrap("true", undefined, "wrong"), "s3cret");
    expect(readdirSync(home)).toEqual([]);
  });

  it("timeout 包在 sudo 里面，退出码照样传回", () => {
    const w = sudoWrap(remoteTimeoutWrap(cmd, 7), "", "s3cret");
    expect(w.cmd).toMatch(/sudo -A -H -- env -u MCP_SUDO_PW .* 'sh -c '\\''exec timeout -k 5/);
    const r = login(w, "s3cret");
    expect(r.stdout).toBe("a b|it's|5|\n");
    expect(r.status).toBe(3);
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
