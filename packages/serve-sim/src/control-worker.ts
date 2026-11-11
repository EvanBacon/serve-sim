/**
 * A pre-warmed, single-use worker. It loads the full CLI bundle ahead of time
 * (that load is most of a cold `serve-sim` call), tells the daemon it is
 * ready, then waits for one command: it adopts the caller's argv, cwd, env,
 * umask and TTY shape, runs the CLI exactly as the normal bin would, and exits.
 *
 * Because every command still gets its own process, `process.exit`, exit
 * codes, signal handlers and module state behave as in a direct run.
 */
import { CONTROL_ROLE_ENV, deferCliMain, type ControlMessage, type StreamTty } from "./control-protocol";

type RunMessage = Extract<ControlMessage, { t: "run" }>;

function adoptTty(stream: NodeJS.WriteStream, tty: StreamTty | undefined): void {
  if (!tty?.isTTY) return;
  // Help wrapping and a couple of commands key off these; the stream itself
  // is a pipe to the daemon, so don't fake any TTY methods.
  Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  if (tty.columns != null) Object.defineProperty(stream, "columns", { value: tty.columns, configurable: true });
}

interface PipeHandle {
  setBlocking?: (blocking: boolean) => void;
}

/**
 * Make writes to the daemon pipe synchronous, as they are for a file or TTY
 * in a direct run, so `write(big); process.exit()` doesn't lose output.
 */
function blockingWrites(stream: NodeJS.WriteStream): void {
  (stream as unknown as { _handle?: PipeHandle })._handle?.setBlocking?.(true);
}

/** @lintignore Exported for tests. */
export function adoptCaller(message: RunMessage, proc: NodeJS.Process = process): void {
  proc.chdir(message.cwd);
  if (typeof message.umask === "number") proc.umask(message.umask);
  for (const key of Object.keys(proc.env)) {
    if (!(key in message.env)) delete proc.env[key];
  }
  Object.assign(proc.env, message.env);
  proc.argv.splice(2, proc.argv.length - 2, ...message.argv);
  adoptTty(proc.stdout, message.tty.stdout);
  adoptTty(proc.stderr, message.tty.stderr);
  blockingWrites(proc.stdout);
  blockingWrites(proc.stderr);
  if (message.sharedOutput) {
    // The caller's stdout and stderr are one file (`2>&1`): send both down
    // one pipe so the daemon can't reorder them. Writes from child
    // processes that inherit fd 2 still travel separately.
    const stdout = proc.stdout;
    proc.stderr.write = ((...args: Parameters<NodeJS.WriteStream["write"]>) =>
      stdout.write(...args)) as NodeJS.WriteStream["write"];
  }
}

export async function runControlWorker(mainUrl: string): Promise<void> {
  delete process.env[CONTROL_ROLE_ENV];
  const send = process.send?.bind(process);
  if (!send) {
    console.error("serve-sim: control worker needs an IPC channel");
    process.exit(70);
  }
  // While idle, follow the daemon down.
  const onDisconnect = () => process.exit(0);
  process.on("disconnect", onDisconnect);

  let main: (() => Promise<unknown>) | null = null;
  deferCliMain((m) => {
    main = m;
  });
  await import(mainUrl);
  const run = main as (() => Promise<unknown>) | null;
  if (!run) {
    console.error("serve-sim: CLI bundle did not hand back its entry point");
    process.exit(70);
  }

  process.once("message", (message: ControlMessage) => {
    if (message?.t !== "run") process.exit(70);
    try {
      adoptCaller(message);
    } catch (error) {
      console.error(`serve-sim: ${(error as Error).message}`);
      process.exit(1);
    }
    // Drop the IPC channel so the event loop drains like a normal run.
    process.off("disconnect", onDisconnect);
    process.disconnect?.();
    run().catch((error) => {
      // Same as an uncaught top-level await rejection: stack on stderr, exit 1.
      setImmediate(() => {
        throw error;
      });
    });
  });
  send({ t: "ready" });
}
