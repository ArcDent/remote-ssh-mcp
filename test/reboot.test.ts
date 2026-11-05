import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rebootLater, waitForBoot } from "../src/tools/reboot.js";

describe("waitForBoot", () => {
  // 假时钟：sleep 只把时间往前拨，不真等。
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("前三次连不上、第四次 boot_id 变了：报告已回来，停机约 15 秒", async () => {
    const reads = [null, null, null, "new"];
    const ticks: number[] = [];
    const r = await waitForBoot(async () => reads.shift() ?? null, "old", 300, (s) => ticks.push(s), fakeClock());
    expect(r).toEqual({ back: true, downS: 15 });
    expect(ticks).toEqual([0, 5, 10, 15]);
  });

  it("一直读到旧 boot_id 直到上限：报错写明重启命令可能没生效", async () => {
    let n = 0;
    const r = await waitForBoot(async () => (n++, "old"), "old", 300, undefined, fakeClock());
    expect(r).toEqual({ back: false, error: "等了 300 秒，boot_id 一直没变，重启命令可能没生效。" });
    expect(n).toBe(61);
  });

  it("到上限还连不上：报错写明主机还没回来", async () => {
    const r = await waitForBoot(async () => null, "old", 30, undefined, fakeClock());
    expect(r).toEqual({ back: false, error: "等了 30 秒主机还没回来，可能还在启动，稍后用 exec 再看看。" });
  });
});

describe("rebootLater", () => {
  it("命令立即返回，重启在后台、脱离当前 shell 执行", async () => {
    // 假的 systemctl 只留个记号，看它是不是在 shell 退出之后才被调用。
    const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-reboot-"));
    const mark = join(dir, "rebooted");
    writeFileSync(join(dir, "systemctl"), `#!/bin/sh\necho "$@" > "${mark}"\n`, { mode: 0o755 });
    const t0 = Date.now();
    const r = spawnSync("/bin/sh", ["-c", `${rebootLater(1)}\necho started`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    expect(r.stdout).toBe("started\n");
    expect(Date.now() - t0).toBeLessThan(800);
    expect(existsSync(mark)).toBe(false);
    // macOS 第一次运行新写的可执行文件可能要多等一会儿，所以轮询而不是固定等。
    for (let i = 0; i < 50 && !existsSync(mark); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spawnSync("cat", [mark], { encoding: "utf8" }).stdout).toBe("reboot\n");
  }, 10_000);
});
