/** How this serve-sim process can invoke itself (re-exec, host RPCs). */

export interface SelfProcess {
  argv: readonly string[];
  execPath: string;
}

const SERVE_SIM_BIN_RE = /(^|\/)serve-sim$/;

/**
 * Path of the compiled standalone binary, or null when running a script
 * entry under node/bun. In a `bun build --compile` binary argv[0] is `bun`
 * and argv[1] is a virtual `/$bunfs/...` path that can't be spawned, so the
 * real binary comes from `execPath`.
 */
function compiledBinary(proc: SelfProcess): string | null {
  const [arg0, arg1] = proc.argv;
  if (arg0 && SERVE_SIM_BIN_RE.test(arg0)) return arg0;
  if (arg1?.startsWith("/$bunfs/")) return proc.execPath;
  return null;
}

/** Resolve the command to re-exec this CLI (compiled binary or `node …js`). */
export function reExecArgs(
  extra: string[],
  proc: SelfProcess = process,
): { command: string; args: string[] } {
  const bin = compiledBinary(proc);
  if (bin) return { command: bin, args: extra };
  // Running the script entry: `node /path/to/serve-sim.js`.
  return { command: proc.argv[0]!, args: [proc.argv[1]!, ...extra] };
}

/**
 * serve-sim CLI entry for `serveSimArgv` (host-rpc): the compiled binary, or
 * the script entry that `node`/`bun` runs.
 */
export function selfServeSimBin(proc: SelfProcess = process): string {
  return compiledBinary(proc) ?? proc.argv[1] ?? "serve-sim";
}
