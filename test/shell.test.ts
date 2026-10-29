import { describe, expect, it } from "vitest";
import { decodeClixml, hostShells, MAX_ENCODED_CHARS, powershellCommand, PS_PRELUDE } from "../src/shell.js";

describe("hostShells", () => {
  it("读取 host=shell 配对，跳过写错的项", () => {
    expect([...hostShells(" arcwin=powershell, box=pwsh,bad=fish,=pwsh,noeq ")]).toEqual([
      ["arcwin", "powershell"],
      ["box", "pwsh"],
    ]);
    expect(hostShells(undefined).size).toBe(0);
  });
});

describe("powershellCommand", () => {
  const decode = (line: string) => Buffer.from(line.split(" ").pop()!, "base64").toString("utf16le");

  it("为 Windows PowerShell 把前导和脚本一起编码", () => {
    const script = `$x='a"b'; "$x $HOME" | Out-File 'C:\\t\\it''s.txt'; exit 5`;
    const line = powershellCommand("powershell", script);
    expect(line.startsWith("powershell.exe -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ")).toBe(true);
    expect(decode(line)).toBe(PS_PRELUDE + script);
    expect(line.split(" ").pop()).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("标准输入按 UTF-8 读，不按系统代码页", () => {
    expect(PS_PRELUDE).toContain("[Console]::InputEncoding = [Text.Encoding]::UTF8");
    expect(PS_PRELUDE.trimEnd()).not.toContain("\n");
  });

  it("PowerShell 7 用 pwsh；脚本长到放不进命令行时拒绝", () => {
    expect(powershellCommand("pwsh", "1").startsWith("pwsh ")).toBe(true);
    expect(() => powershellCommand("powershell", "x".repeat(MAX_ENCODED_CHARS))).toThrow(/太长/);
  });
});

describe("decodeClixml", () => {
  const xmlns = 'xmlns="http://schemas.microsoft.com/powershell/2004/04"';

  it("把 Windows PowerShell 5.1 的错误行还原成文本", () => {
    const lines = [
      "Write-Error : boom &lt;&amp;&gt; 中文",
      "At line:1 char:1",
      "+ ~~~~~~~~~~~~~~~~",
      "    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException",
      " ",
    ];
    const err =
      `#< CLIXML\r\n<Objs Version="1.1.0.1" ${xmlns}>` +
      lines.map((l) => `<S S="Error">${l}_x000D__x000A_</S>`).join("") +
      "</Objs>";
    expect(decodeClixml(err)).toBe(
      "Write-Error : boom <&> 中文\nAt line:1 char:1\n+ ~~~~~~~~~~~~~~~~\n" +
        "    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException\n \n",
    );
  });

  it("错误对象取 ToString，警告加前缀，进度记录丢掉", () => {
    const err =
      `#< CLIXML\n<Objs Version="1.1.0.1" ${xmlns}>` +
      '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64></MS></Obj>' +
      '<S S="warning">careful</S>' +
      '<Obj S="Error" RefId="1"><TN RefId="1"><T>System.Management.Automation.ErrorRecord</T><T>System.Object</T></TN>' +
      '<ToString>boom &lt;&amp;&gt; 中文</ToString><MS><S N="Message">inner</S></MS></Obj>' +
      "</Objs>";
    expect(decodeClixml(err)).toBe("WARNING: careful\nboom <&> 中文\n");
  });

  it("解码 2026-10-28 测试里 arcwin 的 PowerShell 5.1 返回的标准错误", () => {
    const err =
      "#< CLIXML\r\n" +
      `<Objs Version="1.1.0.1" ${xmlns}>` +
      '<S S="Error">Get-Item : 找不到路径“C:\\definitely\\missing\\path”，因为该路径不存在。_x000D__x000A_</S>' +
      '<S S="Error">所在位置 行:2 字符: 11_x000D__x000A_</S>' +
      '<S S="Error">+ "before"; Get-Item C:\\definitely\\missing\\path; "after-should-not-prin ..._x000D__x000A_</S>' +
      '<S S="Error">+           ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~_x000D__x000A_</S>' +
      '<S S="Error">    + CategoryInfo          : ObjectNotFound: (C:\\definitely\\missing\\path:String) [Get-Item], ItemNotFoundException_x000D__x000A_</S>' +
      '<S S="Error">    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetItemCommand_x000D__x000A_</S>' +
      '<S S="Error"> _x000D__x000A_</S></Objs>';
    const out = decodeClixml(err);
    expect(out).not.toContain("CLIXML");
    expect(out).not.toContain("<Objs");
    expect(out).not.toContain("_x000D_");
    expect(out.startsWith("Get-Item : 找不到路径“C:\\definitely\\missing\\path”，因为该路径不存在。\n所在位置 行:2 字符: 11\n")).toBe(true);
  });

  it("保留 CLIXML 块前后的文本，其他标准错误不动", () => {
    const err = `native err\n#< CLIXML\r\n<Objs Version="1.1.0.1" ${xmlns}><S S="Error">a_x005F_x000D_b_x000D__x000A_</S></Objs>\r\nafter\n`;
    expect(decodeClixml(err)).toBe("native err\na_x000D_b\nafter\n");
    expect(decodeClixml("plain error\n")).toBe("plain error\n");
  });
});
