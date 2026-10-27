import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 600;

/** Options added to every call: reuse one connection per host, never prompt, fail fast. */
export const SSH_OPTIONS = [
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${join(homedir(), ".ssh", "mcp-cm-%C")}`,
  "-o", "ControlPersist=10m",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-T",
];

export interface SshResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutS: number;
}

export interface SshOptions {
  timeoutS?: number;
  stdin?: string;
}

/**
 * Runs `remoteCmd` on `host` the same way `ssh host '<remoteCmd>'` would: the string goes to
 * ssh as one argv entry, so no local shell quoting is involved.
 */
export function runSsh(host: string, remoteCmd: string, opts: SshOptions = {}): Promise<SshResult> {
  const timeoutS = Math.min(Math.max(opts.timeoutS ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
  return new Promise((resolve) => {
    const child = spawn("ssh", [...SSH_OPTIONS, "--", host, remoteCmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let done = false;
    const finish = (code: number | null, extraErr = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + extraErr,
        timedOut,
        timeoutS,
      });
    };
    const timer = setTimeout(() => {
      // A multiplexed client hands its stdio to the master, so the pipes stay open until the
      // remote command ends; return now instead of waiting for "close".
      timedOut = true;
      child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
      finish(null);
    }, timeoutS * 1000);

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");

    child.on("error", (e) => finish(null, String(e)));
    child.on("close", (code) => finish(code));
  });
}

export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}
