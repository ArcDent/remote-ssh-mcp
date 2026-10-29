export const SHELLS = ["posix", "pwsh", "powershell"] as const;
export type Shell = (typeof SHELLS)[number];

/** 解析 SSH_MCP_HOST_SHELLS：逗号分隔的 host=shell，如 "arcwin=powershell"，写错的项跳过。 */
export function hostShells(spec: string | undefined): Map<string, Shell> {
  const map = new Map<string, Shell>();
  for (const pair of spec?.split(",") ?? []) {
    const [host, shell] = pair.split("=").map((s) => s.trim());
    if (host && (SHELLS as readonly string[]).includes(shell)) map.set(host, shell as Shell);
  }
  return map;
}

/**
 * 在 agent 的脚本之前运行，做三件事：输入输出都用 UTF-8，否则标准输入会按系统代码页（比如 GBK）
 * 解码；只输出纯文本，不带 ANSI 颜色，也不带进度记录（进度记录会以 CLIXML 出现在标准错误里）；
 * 出错即停，退出码为 1。进程没有控制台时切换 UTF-8 可能抛错，所以包在 try 里。前导只占一行，
 * 报错里的行号只偏一行。
 */
export const PS_PRELUDE =
  "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::InputEncoding = [Text.Encoding]::UTF8 } catch {}; " +
  'if ($PSStyle) { $PSStyle.OutputRendering = "PlainText" }; ' +
  '$ProgressPreference = "SilentlyContinue"; $ErrorActionPreference = "Stop"\n';

/** Windows 命令行最长 32767 字符，编码后的脚本要留出余量。 */
export const MAX_ENCODED_CHARS = 30000;

/**
 * 生成用 PowerShell 7（pwsh）或 Windows PowerShell 5.1 运行 `script` 的命令行。脚本按
 * -EncodedCommand 的要求转成 UTF-16LE 再 base64 编码，途经的 Git Bash、cmd.exe 或 sh 都改不动
 * 它的引号和 `$`。标准输入留给数据，脚本里用 `[Console]::In.ReadToEnd()` 读。
 */
export function powershellCommand(shell: "pwsh" | "powershell", script: string): string {
  const exe = shell === "pwsh" ? "pwsh" : "powershell.exe";
  const encoded = Buffer.from(PS_PRELUDE + script, "utf16le").toString("base64");
  if (encoded.length > MAX_ENCODED_CHARS) {
    throw new Error("PowerShell 脚本太长，超出 Windows 命令行的长度上限；大段数据请经 stdin 传入。");
  }
  return `${exe} -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ${encoded}`;
}

const CLIXML_BLOCK = /#< CLIXML\r?\n(<Objs\b[\s\S]*?(?:<\/Objs>(?:\r?\n)?|$))/g;
/** 一条流记录：`<S S="Error">text</S>`，或 ErrorRecord 这类对象，对象取它的 ToString。 */
const CLIXML_RECORD =
  /<S S="(\w+)">([^<]*)<\/S>|<Obj S="(\w+)"[^>]*>\s*(?:<TNRef[^>]*\/>|<TN\b[^>]*>(?:<T>[^<]*<\/T>)*<\/TN>)?\s*<ToString>([^<]*)<\/ToString>/g;
const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/**
 * 标准错误不是控制台时，Windows PowerShell 5.1 会把它写成 CLIXML，-OutputFormat 设了也没用。
 * 这里把每个 CLIXML 块还原成 PowerShell 本来会打印的文本：warning、verbose、debug 行加上平时的
 * 前缀，进度记录丢掉。
 */
export function decodeClixml(s: string): string {
  return s.replace(CLIXML_BLOCK, (_m, objs: string) => {
    let out = "";
    for (const [, sStream, sText, oStream, oText] of objs.matchAll(CLIXML_RECORD)) {
      const stream = (sStream ?? oStream).toLowerCase();
      if (stream === "progress") continue;
      const line = unescapeClixml(sText ?? oText).replace(/\r\n/g, "\n");
      const prefix = ["warning", "verbose", "debug"].includes(stream) ? `${stream.toUpperCase()}: ` : "";
      out += prefix + line + (line.endsWith("\n") ? "" : "\n");
    }
    return out;
  });
}

/** 先还原 XML 实体，再还原 CLIXML 给控制字符用的 `_xHHHH_` 转义（`_` 本身写作 `_x005F_`）。 */
function unescapeClixml(s: string): string {
  return s
    .replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (m, hex: string, dec: string, name: string) =>
      hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : XML_ENTITIES[name] ?? m,
    )
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
