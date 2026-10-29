import { describe, expect, it } from "vitest";
import { applyEdits } from "../src/tools/files.js";

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
