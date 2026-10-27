import { z } from "zod";
import { checkCommand } from "../guard.js";
import { assertHost } from "../hosts.js";
import { formatResult, text, type ToolText } from "../output.js";
import { runSsh, shQuote, type SshOptions } from "../ssh.js";

// No per-field description: the alias list lives once in exec's description, which keeps
// the tool definitions (sent to the model every turn) small.
export const hostArg = z.string();
export const timeoutArg = z.number().int().min(1).max(600).optional().describe("Seconds, default 60");
export const maxCharsArg = z
  .number().int().min(200).max(100000).optional()
  .describe("Per-stream output cap, default 8000");

export interface RunOptions extends SshOptions {
  maxChars?: number;
  /** User-supplied command to check against the power/package guard before running. */
  guard?: string;
}

/** Validates the host (and guarded command), runs over ssh and formats; failures become isError results. */
export async function run(host: string, remoteCmd: string, o: RunOptions = {}): Promise<ToolText> {
  try {
    assertHost(host);
    if (o.guard !== undefined) {
      const refusal = checkCommand(o.guard);
      if (refusal) return text(refusal, true);
    }
    return formatResult(await runSsh(host, remoteCmd, o), o.maxChars);
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

/** Wraps a generated POSIX script so it runs under `sh` whatever the remote login shell is. */
export function sh(script: string): string {
  return `sh -c ${shQuote(script)}`;
}

export { shQuote };
