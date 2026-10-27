import { describe, expect, it } from "vitest";
import { compactJson, formatResult, truncate } from "../src/output.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}`).join("\n") + "\n";

describe("truncate", () => {
  it("leaves short output alone", () => {
    expect(truncate("abc\n", 10)).toBe("abc\n");
  });

  it("keeps whole first and last lines within the cap and says how much was cut", () => {
    const s = lines(200000);
    const t = truncate(s, 8000);
    const body = t.replace(/\.\.\.\[truncated \d+ chars\]\.\.\.\n/, "");
    expect(body.length).toBeLessThanOrEqual(8000);
    expect(t.startsWith("1\n2\n")).toBe(true);
    expect(t.endsWith("199999\n200000\n")).toBe(true);
    const omitted = Number(/truncated (\d+) chars/.exec(t)![1]);
    expect(omitted + body.length).toBe(s.length);
  });
});

describe("compactJson", () => {
  it("puts a JSON document on one line", () => {
    expect(compactJson('{"a": 1,  "b": [1, 2]}\n')).toBe('{"a":1,"b":[1,2]}\n');
    expect(compactJson('[\n  {"x": "y z"}\n]')).toBe('[{"x":"y z"}]\n');
  });

  it("leaves non-JSON and mixed output untouched", () => {
    for (const s of ["hello\n", '{"a":1}\nextra\n', "[not json", "42\n"]) expect(compactJson(s)).toBe(s);
  });
});

describe("formatResult", () => {
  it("shows exit code, stdout and only non-empty stderr", () => {
    const r = formatResult({ code: 0, stdout: "ok\n", stderr: "", timedOut: false, timeoutS: 60 });
    expect(r.content).toEqual([{ type: "text", text: "exit=0\nok" }]);
    expect(r.isError).toBeUndefined();
    const e = formatResult({ code: 2, stdout: "", stderr: "boom\n", timedOut: false, timeoutS: 60 });
    expect(e.content[0]).toEqual({ type: "text", text: "exit=2\n[stderr]\nboom" });
  });

  it("flags timeouts and ssh errors", () => {
    expect(formatResult({ code: null, stdout: "", stderr: "", timedOut: true, timeoutS: 2 }).isError).toBe(true);
    const r = formatResult({ code: 255, stdout: "", stderr: "Connection refused\n", timedOut: false, timeoutS: 60 });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("ssh connection error") });
  });
});
