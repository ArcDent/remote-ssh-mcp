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
  it("collects concrete aliases from the config and its Includes, skipping patterns", () => {
    const { config } = fixture();
    expect(listHosts(config).sort()).toEqual(["db1", "db2", "extra-one", "inc-a", "inc-b", "web1"]);
  });

  it("sees aliases added after startup without a restart", () => {
    const { config } = fixture();
    expect(listHosts(config)).not.toContain("new-host");
    appendFileSync(config, "\nHost new-host\n");
    expect(listHosts(config)).toContain("new-host");
  });

  it("returns nothing for a missing config", () => {
    expect(listHosts(join(tmpdir(), "no-such-ssh-config"))).toEqual([]);
  });
});

describe("assertHost", () => {
  it("accepts an alias and rejects IPs, patterns and option-like strings with the alias list", () => {
    const { config } = fixture();
    expect(() => assertHost("web1", config)).not.toThrow();
    for (const bad of ["1.2.3.4", "root@10.0.0.10", "*", "-oProxyCommand=x", "web-1"]) {
      expect(() => assertHost(bad, config)).toThrow(/Unknown host .*web1/);
    }
  });
});
