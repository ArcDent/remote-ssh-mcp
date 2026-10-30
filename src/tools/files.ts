import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatResult, REDACTED, text } from "../output.js";
import { hostArg, maxCharsArg, run, runRaw, sh, shQuote, sudoArgs, type ToolExtra, type ToolFilter } from "./common.js";

const pathArg = z.string().min(1).describe("远端绝对路径");
const tagArg = z.string().regex(/^[A-Za-z0-9._-]+$/);

/**
 * `bk <path> <tag> [name]` 把文件复制（目录则打成 tar 包）到 $HOME/ops-backups/<YYYYMMDD>-<tag>/[name]，
 * 不会覆盖之前的备份；旁边再写一个 `<name>.sha256`，在该目录里可直接用 `sha256sum -c` 校验。
 */
const BACKUP_FN = `
bk() {
  dir="$HOME/ops-backups/$(date +%Y%m%d)-$2"; mkdir -p "$dir" || return 1
  name=\${3:-$(basename "$1")}; [ -d "$1" ] && name="$name.tar.gz"
  dst="$dir/$name"; n=1
  while [ -e "$dst" ]; do dst="$dir/$name.$(date +%H%M%S)-$n"; n=$((n+1)); done
  if [ -d "$1" ]; then tar czf "$dst" -C "$(dirname "$1")" "$(basename "$1")" || return 1
  else cp -p "$1" "$dst" || return 1; fi
  (cd "$dir" && sha256sum "$(basename "$dst")" > "$(basename "$dst").sha256") || return 1
  echo "backup: $dst"
  echo "sha256: $(cut -d' ' -f1 "$dst.sha256")"
}`;

export function registerFiles(server: McpServer, on: ToolFilter): void {
  if (on("file_read")) server.registerTool(
    "file_read",
    {
      description: "读取远端文本文件，可指定行范围。",
      inputSchema: {
        host: hostArg,
        path: pathArg,
        start_line: z.number().int().min(1).optional(),
        lines: z.number().int().min(1).optional().describe("从 start_line 起读几行"),
        max_chars: maxCharsArg,
        ...sudoArgs,
      },
    },
    ({ host, path, start_line, lines, max_chars, sudo, pswd }, extra) => {
      const from = start_line ?? 1;
      const range = lines ? `${from},${from + lines - 1}p` : `${from},$p`;
      const read = start_line || lines ? `sed -n '${range}' "$p"` : `cat "$p"`;
      const script = `p=${shQuote(path)}; [ -f "$p" ] || { echo "not a file: $p" >&2; exit 1; }; ${read}`;
      return run(host, sh(script), { maxChars: max_chars, extra, sudo, pswd });
    },
  );

  if (on("file_write")) server.registerTool(
    "file_write",
    {
      description:
        "把 content 原样写进远端文件（不用转义），或用 edits 改其中几处。overwrite 和 edits 先把旧文件备份到 " +
        "~/ops-backups/<date>-auto/，再原子替换，保留权限和属主；append 追加到文件末尾。",
      inputSchema: {
        host: hostArg,
        path: pathArg,
        content: z.string().optional(),
        edits: z
          .array(z.object({ old: z.string().min(1), new: z.string() })).min(1).optional()
          .describe("代替 content：把每个 old 换成 new，old 必须在文件里刚好出现一次"),
        mode: z.enum(["overwrite", "append"]).default("overwrite"),
        backup: z.boolean().default(true).describe("覆盖前先备份"),
        ...sudoArgs,
      },
    },
    ({ host, path, content, edits, mode, backup, sudo, pswd }, extra) => {
      if ((content === undefined) === (edits === undefined)) return text("content 和 edits 必须且只能传一个。", true);
      if (edits) {
        if (mode === "append") return text("edits 不能和 mode append 一起用。", true);
        return editFile(host, path, edits, backup, extra, { sudo, pswd });
      }
      return run(host, sh(writeScript(path, mode, backup)), { stdin: content, extra, sudo, pswd });
    },
  );

  if (on("backup_file")) server.registerTool(
    "backup_file",
    {
      description:
        "把远端文件或目录（目录打成 tar.gz）备份到 ~/ops-backups/<YYYYMMDD>-<tag>/，附 sha256 文件。用 exec 改文件前先用它备份。",
      inputSchema: { host: hostArg, path: pathArg, tag: tagArg.describe("简短的名字，如 xray-chain"), ...sudoArgs },
    },
    ({ host, path, tag, sudo, pswd }, extra) => {
      const script = `p=${shQuote(path)}; [ -e "$p" ] || { echo "not found: $p" >&2; exit 1; }
${BACKUP_FN}
bk "$p" ${shQuote(tag)}`;
      return run(host, sh(script), { extra, sudo, pswd });
    },
  );
}

/** 超过这个大小的文件不接受 edits，因为文件要传到本机再传回去。 */
const MAX_EDIT_BYTES = 1024 * 1024;

/**
 * 按顺序应用 `edits`；每个 `old` 在轮到它时的文本里必须刚好出现一次，否则抛错并写明出现次数。
 */
export function applyEdits(text: string, edits: { old: string; new: string }[]): string {
  return edits.reduce((t, e, i) => {
    const at = t.indexOf(e.old);
    const again = at < 0 ? -1 : t.indexOf(e.old, at + e.old.length);
    if (at < 0) throw new Error(`edits[${i}].old 在文件里出现 0 次；请从当前文件里原样复制，空白也要一致。`);
    if (again >= 0) {
      const n = t.split(e.old).length - 1;
      throw new Error(`edits[${i}].old 出现了 ${n} 次，只能出现 1 次；请带上前后几行让它唯一。`);
    }
    return t.slice(0, at) + e.new + t.slice(at + e.old.length);
  }, text);
}

/**
 * 读出文件，在本机应用 edits，再经 writeScript 写回；写之前先核对文件的 sha256 和读出时一致。
 * 主机上不需要 python 或 sed。
 */
async function editFile(
  host: string,
  path: string,
  edits: { old: string; new: string }[],
  backup: boolean,
  extra: ToolExtra,
  asRoot: { sudo?: boolean; pswd?: string },
) {
  const read = await runRaw(
    host,
    sh(`p=${shQuote(path)}; [ -L "$p" ] && p=$(readlink -f "$p")
[ -f "$p" ] || { echo "not a file: $p" >&2; exit 1; }
[ "$(wc -c < "$p")" -le ${MAX_EDIT_BYTES} ] || { echo "too big for edits (over 1 MB): $p" >&2; exit 1; }
base64 < "$p"`),
    { extra, ...asRoot },
  );
  if (read.code !== 0) return formatResult(read);
  const buf = Buffer.from(read.stdout, "base64");
  const before = buf.toString("utf8");
  if (!Buffer.from(before, "utf8").equals(buf)) return text(`${path} 不是 UTF-8 文本，请改用 content 整份写入。`, true);
  const after = applyEdits(before, edits);
  const sha = createHash("sha256").update(buf).digest("hex");
  return run(host, sh(writeScript(path, "overwrite", backup, sha)), { stdin: after, extra, ...asRoot });
}

/**
 * 把标准输入写进 `path`。内容先写到目标旁边的临时文件，写入被拒或失败时原文件不受影响。内容里有
 * REDACTED 时拒绝写入，除非原文件里本来就有：这个标记来自打码后的工具输出，写回去会冲掉真密钥。
 */
export function writeScript(path: string, mode: "overwrite" | "append", backup: boolean, expectSha?: string): string {
  const unchanged = expectSha
    ? `[ -f "$p" ] && [ "$(sha256sum < "$p" | cut -d' ' -f1)" = ${shQuote(expectSha)} ] || ` +
      `{ echo "$p changed since it was read; read it again and retry" >&2; exit 1; }`
    : "";
  return `set -e
p=${shQuote(path)}
[ -L "$p" ] && p=$(readlink -f "$p")
${unchanged}
d=$(dirname "$p"); mkdir -p "$d"
${BACKUP_FN}
t=$(mktemp "$d/.mcp-write.XXXXXX"); trap 'rm -f "$t"' EXIT
cat > "$t"
if grep -qF ${shQuote(REDACTED)} "$t" && ! { [ -f "$p" ] && grep -qF ${shQuote(REDACTED)} "$p"; }; then
  echo "refused: content contains ${REDACTED}, a value masked in tool output; read it with redact:false and write the real value" >&2
  exit 1
fi
if [ ${shQuote(mode)} = append ]; then
  cat "$t" >> "$p"; echo "appended to $p ($(wc -c < "$p") bytes now)"; exit 0
fi
# auto backups share one directory, so name them after the full path (/etc/a.conf -> etc_a.conf)
if [ -e "$p" ] && [ ${backup ? 1 : 0} = 1 ]; then bk "$p" auto "$(echo "$p" | sed 's|^/||; s|/|_|g')"; fi
# copy owner, then mode: GNU and busybox take stat -c, macOS takes stat -f; chown after chmod would clear setuid
if [ -e "$p" ]; then
  o=$(stat -c %u:%g "$p" 2>/dev/null || stat -f %u:%g "$p")
  m=$(stat -c %a "$p" 2>/dev/null || stat -f %Mp%Lp "$p")
  chown "$o" "$t" 2>/dev/null || true
  chmod "$m" "$t"
else
  chmod "$(printf '%o' $((0666 & ~$(umask))))" "$t"
fi
mv -f "$t" "$p"
echo "wrote $p ($(wc -c < "$p") bytes)"`;
}
