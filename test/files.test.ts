import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEdits, writeScript } from "../src/tools/files.js";

describe("applyEdits", () => {
  const conf = "listen 443;\nserver_name a;\nlisten 443;\n";

  it("按顺序应用每处修改，后一处作用在前一处的结果上", () => {
    expect(applyEdits(conf, [{ old: "server_name a;", new: "server_name b;" }, { old: "b;", new: "c; # $x `y`" }])).toBe(
      "listen 443;\nserver_name c; # $x `y`\nlisten 443;\n",
    );
  });

  it("old 不存在或不唯一时拒绝，并指出是哪一处修改", () => {
    expect(() => applyEdits(conf, [{ old: "nope", new: "" }])).toThrow(/edits\[0\]\.old 在文件里出现 0 次/);
    expect(() => applyEdits(conf, [{ old: "a;", new: "b;" }, { old: "listen 443;", new: "x" }])).toThrow(
      /edits\[1\]\.old 出现了 2 次/,
    );
  });
});

describe("覆盖写入", () => {
  // 在本机 sh 上跑写入脚本；macOS 的 stat 没有 -c，要走 stat -f 那一支。
  const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-write-"));
  const write = (path: string, content: string) =>
    spawnSync("/bin/sh", ["-c", writeScript(path, "overwrite", false)], {
      input: content,
      encoding: "utf8",
      env: { ...process.env, HOME: dir },
    });

  it.each([0o600, 0o444, 0o4755])("保留原文件的权限 %o", (mode) => {
    const p = join(dir, `f${mode.toString(8)}`);
    writeFileSync(p, "old\n");
    chmodSync(p, mode);
    const r = write(p, "new\n");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readFileSync(p, "utf8")).toBe("new\n");
    expect(statSync(p).mode & 0o7777).toBe(mode);
  });
});
