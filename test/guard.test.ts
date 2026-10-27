import { describe, expect, it } from "vitest";
import { checkCommand, findDangers, guardEnv } from "../src/guard.js";

const deny = { allowPower: false, allowPkg: false };

describe("findDangers", () => {
  it.each([
    "reboot",
    "true || reboot",
    "sudo reboot",
    "sudo -u root /sbin/shutdown -h now",
    "echo bye; poweroff",
    "cd / && halt -p",
    "systemctl reboot",
    "systemctl --no-block poweroff",
    "init 6",
    "timeout 5 reboot",
    "FOO=1 env -i reboot",
    'bash -c "echo hi; reboot"',
    "sh -c 'shutdown -r +1'",
    'echo "$(reboot)"',
    "echo `halt`",
    "(sleep 1; reboot) &",
    "x=1\nreboot",
  ])("flags power command: %s", (cmd) => {
    expect(findDangers(cmd).map((d) => d.kind)).toContain("power");
  });

  it.each([
    "apt-get install -y curl",
    "apt-get -s install sl",
    "DEBIAN_FRONTEND=noninteractive apt-get --no-install-recommends -y install curl",
    "sudo apt remove nginx",
    "apt purge x",
    "apt-get dist-upgrade",
    "yum install -y htop",
    "dnf remove x",
    "apk add curl",
    "dpkg -i x.deb",
    "dpkg --configure -a",
    "apt-get update && apt-get upgrade -y",
  ])("flags package command: %s", (cmd) => {
    expect(findDangers(cmd).map((d) => d.kind)).toContain("pkg");
  });

  it.each([
    "last -x reboot",
    "apt-cache policy curl",
    "journalctl | grep shutdown",
    'grep -E "reboot|shutdown" /var/log/syslog',
    "echo reboot-log",
    "echo 'reboot; now'",
    "systemctl status reboot.target",
    "systemctl is-active x-ui",
    "dpkg -l | grep xray",
    "apt list --installed",
    "apt-get update",
    "docker ps",
    "cat /etc/init.d/x-ui",
    "ls /var/cache/apt",
  ])("leaves ordinary command alone: %s", (cmd) => {
    expect(findDangers(cmd)).toEqual([]);
  });
});

describe("checkCommand", () => {
  it("refuses with a hint to run it manually, and env flags lift each class separately", () => {
    expect(checkCommand("true || reboot", deny)).toMatch(/Blocked: power.*manually.*SSH_MCP_ALLOW_POWER=1/);
    expect(checkCommand("apt-get -s install sl", deny)).toMatch(/Blocked: package.*SSH_MCP_ALLOW_PKG=1/);
    expect(checkCommand("true || reboot", { allowPower: true, allowPkg: false })).toBeNull();
    expect(checkCommand("apt-get -s install sl", { allowPower: true, allowPkg: false })).toMatch(/Blocked/);
    expect(checkCommand("apt-get -s install sl", { allowPower: false, allowPkg: true })).toBeNull();
    expect(checkCommand("uptime", deny)).toBeNull();
  });

  it("reads the env flags, only exactly 1 enables", () => {
    expect(guardEnv({ SSH_MCP_ALLOW_POWER: "1", SSH_MCP_ALLOW_PKG: "true" })).toEqual({
      allowPower: true,
      allowPkg: false,
    });
  });
});
