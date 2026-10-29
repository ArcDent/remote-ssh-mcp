import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertHost, listHosts } from "../src/hosts.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-hosts-"));
  mkdirSync(join(dir, "conf.d"));
  writeFileSync(join(dir, "conf.d", "a.conf"), "Host inc-a\n  HostName 10.0.0.1\n");
  writeFileSync(join(dir, "conf.d", "b.conf"), "Host=inc-b\n");
  writeFileSync(join(dir, "extra"), "Host extra-one\n");
  const config = join(dir, "config");
  writeFileSync(
    config,
    [
      `Include ${join(dir, "conf.d", "*.conf")} ${join(dir, "extra")}`,
      "# Host commented",
      "Host web1",
      "    HostName 10.0.0.3",
      "Host db1 db2",
      "Host *",
      "  ServerAliveInterval 30",
      "Host *.lan web-? !bad",
      `Include ${join(dir, "missing")}`,
    ].join("\n"),
  );
  return { dir, config };
}

describe("listHosts", () => {
  it("从 config 及其 Include 里收集写明的别名，跳过通配模式", () => {
    const { config } = fixture();
    expect(listHosts(config).sort()).toEqual(["db1", "db2", "extra-one", "inc-a", "inc-b", "web1"]);
  });

  it("启动后新加的别名不用重启就能看到", () => {
    const { config } = fixture();
    expect(listHosts(config)).not.toContain("new-host");
    appendFileSync(config, "\nHost new-host\n");
    expect(listHosts(config)).toContain("new-host");
  });

  it("config 不存在时返回空列表", () => {
    expect(listHosts(join(tmpdir(), "no-such-ssh-config"))).toEqual([]);
  });
});

describe("assertHost", () => {
  it("接受别名；IP、通配模式和像选项的字符串一律拒绝，并列出别名", () => {
    const { config } = fixture();
    expect(() => assertHost("web1", config)).not.toThrow();
    for (const bad of ["1.2.3.4", "root@10.0.0.10", "*", "-oProxyCommand=x", "web-1"]) {
      expect(() => assertHost(bad, config)).toThrow(/未知主机.*web1/);
    }
  });
});
