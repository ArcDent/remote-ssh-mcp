import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostArg, maxCharsArg, run, sh, shQuote } from "./common.js";

const pathArg = z.string().min(1).describe("Absolute remote path");
const tagArg = z.string().regex(/^[A-Za-z0-9._-]+$/);

/**
 * `bk <path> <tag> [name]` copies a file (or tars a directory) into
 * $HOME/ops-backups/<YYYYMMDD>-<tag>/[name], never overwriting an earlier backup, and writes a
 * `<name>.sha256` next to it that `sha256sum -c` accepts from inside that directory.
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

export function registerFiles(server: McpServer): void {
  server.registerTool(
    "file_read",
    {
      description: "Read a remote text file, optionally a line range.",
      inputSchema: {
        host: hostArg,
        path: pathArg,
        start_line: z.number().int().min(1).optional(),
        lines: z.number().int().min(1).optional().describe("Line count from start_line"),
        max_chars: maxCharsArg,
      },
    },
    ({ host, path, start_line, lines, max_chars }) => {
      const from = start_line ?? 1;
      const range = lines ? `${from},${from + lines - 1}p` : `${from},$p`;
      const read = start_line || lines ? `sed -n '${range}' "$p"` : `cat "$p"`;
      const script = `p=${shQuote(path)}; [ -f "$p" ] || { echo "not a file: $p" >&2; exit 1; }; ${read}`;
      return run(host, sh(script), { maxChars: max_chars });
    },
  );

  server.registerTool(
    "file_write",
    {
      description:
        "Write content to a remote file verbatim (no escaping). overwrite first backs up the old file to " +
        "~/ops-backups/<date>-auto/, then replaces it atomically, keeping mode and owner; append adds to the end.",
      inputSchema: {
        host: hostArg,
        path: pathArg,
        content: z.string(),
        mode: z.enum(["overwrite", "append"]).default("overwrite"),
        backup: z.boolean().default(true).describe("Back up before overwrite"),
      },
    },
    ({ host, path, content, mode, backup }) => {
      const script = `set -e
p=${shQuote(path)}
[ -L "$p" ] && p=$(readlink -f "$p")
d=$(dirname "$p"); mkdir -p "$d"
${BACKUP_FN}
if [ ${shQuote(mode)} = append ]; then
  cat >> "$p"; echo "appended to $p ($(wc -c < "$p") bytes now)"; exit 0
fi
# auto backups share one directory, so name them after the full path (/etc/a.conf -> etc_a.conf)
if [ -e "$p" ] && [ ${backup ? 1 : 0} = 1 ]; then bk "$p" auto "$(echo "$p" | sed 's|^/||; s|/|_|g')"; fi
t=$(mktemp "$d/.mcp-write.XXXXXX"); trap 'rm -f "$t"' EXIT
cat > "$t"
if [ -e "$p" ]; then
  chmod --reference="$p" "$t"; chown --reference="$p" "$t" 2>/dev/null || true
else
  chmod "$(printf '%o' $((0666 & ~$(umask))))" "$t"
fi
mv -f "$t" "$p"
echo "wrote $p ($(wc -c < "$p") bytes)"`;
      return run(host, sh(script), { stdin: content });
    },
  );

  server.registerTool(
    "backup_file",
    {
      description:
        "Back up a remote file or directory (tar.gz) to ~/ops-backups/<YYYYMMDD>-<tag>/ with a sha256 file. Use before editing via exec.",
      inputSchema: { host: hostArg, path: pathArg, tag: tagArg.describe("Short name, e.g. xray-chain") },
    },
    ({ host, path, tag }) => {
      const script = `p=${shQuote(path)}; [ -e "$p" ] || { echo "not found: $p" >&2; exit 1; }
${BACKUP_FN}
bk "$p" ${shQuote(tag)}`;
      return run(host, sh(script));
    },
  );
}
