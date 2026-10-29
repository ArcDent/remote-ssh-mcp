import { describe, expect, it } from "vitest";
import { checkCommand, findDangers, findPwshDangers, guardEnv, stdinIsScript } from "../src/guard.js";

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
  ])("识别为电源类命令：%s", (cmd) => {
    expect(findDangers(cmd).map((d) => d.kind)).toContain("power");
  });

  it.each([
    "apt-get install -y curl",
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
  ])("识别为装包类命令：%s", (cmd) => {
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
  ])("普通命令放行：%s", (cmd) => {
    expect(findDangers(cmd)).toEqual([]);
  });
});

describe("checkCommand", () => {
  it("拒绝时提示手动执行，环境变量分别放开两类命令", () => {
    expect(checkCommand("true || reboot", deny)).toMatch(/已拦截电源类命令.*自己 ssh 上去执行.*SSH_MCP_ALLOW_POWER=1/);
    expect(checkCommand("apt-get install sl", deny)).toMatch(/已拦截装包类命令.*SSH_MCP_ALLOW_PKG=1/);
    expect(checkCommand("true || reboot", { allowPower: true, allowPkg: false })).toBeNull();
    expect(checkCommand("apt-get install sl", { allowPower: true, allowPkg: false })).toMatch(/已拦截/);
    expect(checkCommand("apt-get install sl", { allowPower: false, allowPkg: true })).toBeNull();
    expect(checkCommand("uptime", deny)).toBeNull();
  });

  it("读取环境变量，只有值恰好是 1 才放开", () => {
    expect(guardEnv({ SSH_MCP_ALLOW_POWER: "1", SSH_MCP_ALLOW_PKG: "true" })).toEqual({
      allowPower: true,
      allowPkg: false,
    });
  });
});

describe("stdinIsScript", () => {
  it.each(["sh", "sh -s", "bash -s -- a b", "sudo bash", "cd /tmp && sh"])("shell 从标准输入读脚本：%s", (cmd) => {
    expect(stdinIsScript(cmd)).toBe(true);
  });

  it.each(["python3 -", "sqlite3 -readonly x.db", "cat > /tmp/x", "sh -c 'cat'", "docker exec -i c sh -s"])(
    "标准输入只是数据：%s",
    (cmd) => {
      expect(stdinIsScript(cmd)).toBe(false);
    },
  );
});

describe("findPwshDangers", () => {
  it.each([
    ["Restart-Computer -Force", "power"],
    ["Get-Date; stop-computer", "power"],
    ["Get-Service | ForEach-Object { Restart-Computer }", "power"],
    ["& C:\\Windows\\System32\\shutdown.exe /r /t 0", "power"],
    ['"$(Restart-Computer)"', "power"],
    ["wpeutil reboot", "power"],
    ["winget install foo", "pkg"],
    ["choco upgrade all -y", "pkg"],
    ["Install-Package x", "pkg"],
    ["msiexec /i app.msi /qn", "pkg"],
    ["apt-get install -y sl", "pkg"],
  ])("识别 %s", (cmd, kind) => {
    expect(findPwshDangers(cmd).map((d) => d.kind)).toContain(kind);
  });

  it.each([
    "Write-Output 'Restart-Computer'",
    'Write-Host "winget install foo"',
    "Get-Service | Where-Object Name -eq 'shutdown'",
    "winget list",
    "msiexec /?",
    "Get-Content C:\\logs\\reboot.log -Tail 20",
  ])("放行 %s", (cmd) => {
    expect(findPwshDangers(cmd)).toEqual([]);
  });

  it("checkCommand 检查 PowerShell 时用的就是它", () => {
    expect(checkCommand("Restart-Computer", deny, true)).toMatch(/已拦截电源类命令/);
    expect(checkCommand("Restart-Computer", deny)).toBeNull();
  });
});

describe("绕过写法", () => {
  const kinds = (cmd: string) => findDangers(cmd).map((d) => d.kind);

  describe("带值的选项", () => {
    it.each([
      ["timeout -s KILL 5 reboot", "power"],
      ["timeout -k 3 10 reboot", "power"],
      ["systemctl -H root@h reboot", "power"],
      ["apt-get -o X=Y install sl", "pkg"],
      ["apt -y -o Foo=1 install sl", "pkg"],
    ])("识别 %s", (cmd, kind) => expect(kinds(cmd)).toContain(kind));

    it.each(["timeout 5 ls", "systemctl -H root@h status x"])("放行 %s", (cmd) => expect(kinds(cmd)).toEqual([]));
  });

  describe("包装命令", () => {
    it.each([
      ["su -c reboot", "power"],
      ["su -c 'apt-get install x' root", "pkg"],
      ["echo x | xargs reboot", "power"],
      ["xargs -n1 reboot", "power"],
      ["doas reboot", "power"],
      ["busybox reboot", "power"],
      ["eval reboot", "power"],
      ['eval "apt-get install x"', "pkg"],
      ["sudo -n reboot", "power"],
    ])("识别 %s", (cmd, kind) => expect(kinds(cmd)).toContain(kind));

    it.each(["su - postgres -c 'psql -l'", "xargs -n1 echo", "busybox ls"])("放行 %s", (cmd) =>
      expect(kinds(cmd)).toEqual([]),
    );
  });

  describe("shell 短选项合写", () => {
    it.each(["bash -lc reboot", "sh -ec 'true; reboot'"])("识别 %s", (cmd) => expect(kinds(cmd)).toContain("power"));
    it.each(["bash -e script.sh"])("放行 %s", (cmd) => expect(kinds(cmd)).toEqual([]));
  });

  describe("电源类 target 和 sysrq", () => {
    it.each([
      "systemctl start poweroff.target",
      "systemctl isolate reboot.target",
      "systemctl start halt.target",
      "systemctl start kexec.target",
      "echo b > /proc/sysrq-trigger",
    ])("识别 %s", (cmd) => expect(kinds(cmd)).toContain("power"));

    it.each(["systemctl start nginx", "cat /proc/sys/kernel/sysrq"])("放行 %s", (cmd) =>
      expect(kinds(cmd)).toEqual([]),
    );
  });

  describe("apt 模拟执行", () => {
    it.each([
      "apt-get -s install sl",
      "apt-get --simulate install sl",
      "apt --dry-run upgrade",
      "apt-get --just-print install x",
      "apt-get --no-act remove x",
      "apt list --upgradable",
      "dpkg -l",
    ])("放行 %s", (cmd) => expect(kinds(cmd)).toEqual([]));
  });

  describe("posix 模式下的 Windows 主机（Git Bash）", () => {
    it.each([
      ["shutdown.exe -a", "power"],
      ["/c/Windows/System32/shutdown.exe -a", "power"],
      ["'C:\\Windows\\System32\\shutdown.exe' /r", "power"],
      ["SHUTDOWN -a", "power"],
      ["wpeutil reboot", "power"],
      ["winget install foo", "pkg"],
      ["winget.exe install foo", "pkg"],
      ["choco install -y git", "pkg"],
      ["scoop uninstall x", "pkg"],
      ["msiexec //i app.msi //qn", "pkg"],
    ])("识别 %s", (cmd, kind) => expect(kinds(cmd)).toContain(kind));

    it.each(["winget list", "choco search git", "ls /c/Windows/System32/shutdown.exe"])("放行 %s", (cmd) =>
      expect(kinds(cmd)).toEqual([]),
    );
  });

  describe("cmd /c、powershell -Command 和 Invoke-Expression", () => {
    const encoded = Buffer.from("Restart-Computer -Force", "utf16le").toString("base64");
    it.each([
      ['cmd //c "shutdown -a"', "power"],
      ["cmd.exe /C winget install foo", "pkg"],
      ['powershell.exe -Command "Restart-Computer"', "power"],
      ['powershell -NoProfile -ExecutionPolicy Bypass -c "winget install foo"', "pkg"],
      ['powershell "Stop-Computer"', "power"],
      [`pwsh -NoProfile -EncodedCommand ${encoded}`, "power"],
      [`powershell -enc ${encoded}`, "power"],
    ])("识别 %s", (cmd, kind) => expect(kinds(cmd)).toContain(kind));

    it.each([
      'cmd //c "dir C:\\"',
      'powershell -Command "Get-Service sshd"',
      "pwsh ./restart-computer.ps1",
      "powershell -File C:/x.ps1",
    ])("放行 %s", (cmd) => expect(kinds(cmd)).toEqual([]));

    it.each([
      ['Invoke-Expression "Restart-Computer"', "power"],
      ['iex "winget install foo"', "pkg"],
      ['Invoke-Expression -Command "cmd /c shutdown /a"', "power"],
      ['cmd /c "shutdown /a"', "power"],
      ['powershell.exe -Command "Restart-Computer"', "power"],
    ])("按 PowerShell 规则识别 %s", (cmd, kind) =>
      expect(findPwshDangers(cmd).map((d) => d.kind)).toContain(kind),
    );

    it("无害的 Invoke-Expression 放行", () => {
      expect(findPwshDangers('Invoke-Expression "Get-Date"')).toEqual([]);
    });
  });
});

// arcwin 测试报告（2026-10-28）列出的漏拦用例，每条都经 checkCommand 检查。
describe("arcwin 报告里的 Windows 命令", () => {
  const posix = (cmd: string) => checkCommand(cmd, deny);
  const ps = (cmd: string) => checkCommand(cmd, deny, true);
  const encoded = Buffer.from("Restart-Computer", "utf16le").toString("base64");

  it.each(["shutdown.exe -a", "/c/Windows/System32/shutdown.exe -a", "SHUTDOWN -a"])(
    "posix：把 %s 当电源类命令拦下", (cmd) => expect(posix(cmd)).toMatch(/^已拦截电源类命令/),
  );

  it.each([
    "winget install x", "winget.exe install x", "choco install x", "scoop install x", "msiexec /i x.msi", "msiexec //i x.msi",
  ])("posix：把 %s 当装包类命令拦下", (cmd) => expect(posix(cmd)).toMatch(/^已拦截装包类命令/));

  it.each([
    'cmd //c "shutdown -a"', "cmd /c shutdown /a", 'powershell.exe -Command "Restart-Computer"', "pwsh -c Stop-Computer",
    `powershell -EncodedCommand ${encoded}`,
  ])("posix：拦下 %s", (cmd) => expect(posix(cmd)).toMatch(/^已拦截电源类命令/));

  it.each(['cmd /c "shutdown /a"', 'Invoke-Expression "Restart-Computer"', "iex 'Stop-Computer'"])(
    "PowerShell：拦下 %s", (cmd) => expect(ps(cmd)).toMatch(/^已拦截电源类命令/),
  );

  it.each(["winget list", "choco search x", "echo shutdown", "cmd /c dir", "powershell -Command Get-Date", "iex 'Get-Date'"])(
    "两种模式下都放行 %s", (cmd) => {
      expect(posix(cmd)).toBeNull();
      expect(ps(cmd)).toBeNull();
    },
  );
});
