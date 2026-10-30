import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { xuiBase } from "../src/tools/net.js";

const hasSqlite = spawnSync("sqlite3", ["-version"]).status === 0;

describe.skipIf(!hasSqlite)("xuiBase 找面板库", () => {
  // 在本机 sh 上跑，库和令牌都放临时目录；脚本最后打印算出的面板地址。
  const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-xui-"));
  const token = join(dir, "token");
  writeFileSync(token, "t\n");
  const first = join(dir, "a.db");
  const second = join(dir, "b.db");

  const makeDb = (path: string, settings: Record<string, string>) => {
    const rows = Object.entries(settings).map(([k, v]) => `insert into settings values ('${k}', '${v}');`);
    const r = spawnSync("sqlite3", [path, `create table settings (key text, value text); ${rows.join(" ")}`]);
    expect(r.status).toBe(0);
  };
  const base = (dbs: string[]) =>
    spawnSync("/bin/sh", ["-c", `${xuiBase(dbs, token)}\necho "U=$U"`], { encoding: "utf8" });

  it("库只在第二个路径时用它", () => {
    makeDb(second, { webListen: "", webPort: "40123", webBasePath: "/abc/" });
    const r = base([join(dir, "none.db"), second]);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("U=http://127.0.0.1:40123/abc\n");
  });

  it("两个路径都有库时用第一个", () => {
    makeDb(first, { webPort: "1111", webBasePath: "x" });
    const r = base([first, second]);
    expect(r.stdout).toBe("U=http://127.0.0.1:1111/x\n");
  });

  it("库里没有 webPort 时用面板默认端口 2053", () => {
    const db = join(dir, "noport.db");
    makeDb(db, { webBasePath: "/p/" });
    expect(base([db]).stdout).toBe("U=http://127.0.0.1:2053/p\n");
  });

  it("两处都没有库时报错，列出试过的路径", () => {
    const missing = [join(dir, "x.db"), join(dir, "y.db")];
    const r = base(missing);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("x-ui.db not found");
    for (const p of missing) expect(r.stderr).toContain(p);
  });

  it("库读不出来时报错，不拿默认地址去试", () => {
    const bad = join(dir, "bad.db");
    writeFileSync(bad, "not a database, just some text that is long enough to have a header");
    const r = base([bad]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toBe("");
  });
});
