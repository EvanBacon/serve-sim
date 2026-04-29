import { Bash } from "just-bash";
import { GatewayTransport } from "./transport";
import type { GatewayTransportOptions } from "./transport";

export type { GatewayTransportOptions };

/** Commands that are always bridged to the gateway server. */
const DEFAULT_BRIDGED = [
  "xcrun",
  "curl",
  "unzip",
  "echo",
  "ls",
  "cat",
  "which",
];

export interface ConnectOptions {
  /** WebSocket URL (default: ws://localhost:7070/ws) */
  url?: string;
  /** Auth token. */
  token?: string;
  /** Commands to bridge to the gateway (default: xcrun, curl, echo, ls, cat, which) */
  bridgedCommands?: string[];
}

export class ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;

  constructor(stdout: string, stderr: string, exitCode: number) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }

  /** Return stdout as trimmed text. */
  text(): string {
    return this.stdout.trimEnd();
  }

  /** Parse stdout as JSON. */
  json<T = unknown>(): T {
    return JSON.parse(this.stdout);
  }

  /** Return stdout as bytes. */
  buffer(): Uint8Array {
    return new TextEncoder().encode(this.stdout);
  }

  /** Throw if exit code is non-zero. */
  ok(): this {
    if (this.exitCode !== 0) {
      const msg = this.stderr.trim() || `Command exited with code ${this.exitCode}`;
      throw new ShellError(msg, this);
    }
    return this;
  }
}

export class ShellError extends Error {
  readonly result: ShellResult;
  constructor(message: string, result: ShellResult) {
    super(message);
    this.name = "ShellError";
    this.result = result;
  }
}

/**
 * A promise-like object returned by the `$` tagged template.
 * Supports `.json()`, `.text()`, `.buffer()` directly as chained promises.
 */
export class ShellPromise implements PromiseLike<ShellResult> {
  private inner: Promise<ShellResult>;

  constructor(executor: Promise<ShellResult>) {
    this.inner = executor;
  }

  then<R1 = ShellResult, R2 = never>(
    onFulfilled?: ((value: ShellResult) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.inner.then(onFulfilled, onRejected);
  }

  catch<R = never>(
    onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null
  ): Promise<ShellResult | R> {
    return this.inner.catch(onRejected);
  }

  /** Parse stdout as JSON. */
  json<T = unknown>(): Promise<T> {
    return this.inner.then((r) => r.json<T>());
  }

  /** Return stdout as trimmed text. */
  text(): Promise<string> {
    return this.inner.then((r) => r.text());
  }

  /** Return stdout as bytes. */
  buffer(): Promise<Uint8Array> {
    return this.inner.then((r) => r.buffer());
  }

  /** Throw if exit code is non-zero. */
  ok(): Promise<ShellResult> {
    return this.inner.then((r) => r.ok());
  }
}

/** Split a command string into [command, ...args] respecting quotes. */
function parseCommand(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Escape a value for safe interpolation into a shell command string.
function shellEscape(value: string): string {
  // If it's safe (alphanumeric, dashes, dots, slashes, colons), pass through.
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(value)) return value;
  // Otherwise, single-quote it with internal single-quotes escaped.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface StreamingExecOptions {
  /** Called for each stdout chunk as it arrives from the gateway. */
  onStdout?: (data: string) => void;
  /** Called for each stderr chunk as it arrives from the gateway. */
  onStderr?: (data: string) => void;
}

export interface GatewayShell {
  (strings: TemplateStringsArray, ...values: unknown[]): ShellPromise;
  /** Execute a raw command string (no template escaping). */
  exec(command: string, options?: StreamingExecOptions): ShellPromise;
  writeFile(remotePath: string, data: Uint8Array): Promise<void>;
  readFile(remotePath: string): Promise<Uint8Array>;
  close(): void;
  transport: GatewayTransport;
}

/**
 * Connect to a gateway server and return a `$` tagged template shell.
 *
 * @example
 * ```ts
 * import Gateway from "serve-sim-client";
 *
 * const $ = await Gateway.connect({ token: "dev" });
 *
 * await $`echo hello`;
 * const devices = await $`xcrun simctl list devices -j`.json();
 * $.close();
 * ```
 */
async function connect(
  options: ConnectOptions | string = {}
): Promise<GatewayShell> {
  const opts: ConnectOptions =
    typeof options === "string" ? { token: options } : options;

  const {
    url = "ws://localhost:7070/ws",
    token,
    bridgedCommands = DEFAULT_BRIDGED,
  } = opts;

  const transport = new GatewayTransport({ url, token });
  await transport.waitForOpen();

  const bash = new Bash({
    customCommands: bridgedCommands.map((cmd) => transport.bridge(cmd)),
  });

  function $(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): ShellPromise {
    let cmd = strings[0] ?? "";
    for (let i = 0; i < values.length; i++) {
      cmd += shellEscape(String(values[i])) + (strings[i + 1] ?? "");
    }

    const promise = bash.exec(cmd).then(
      (r) => new ShellResult(r.stdout, r.stderr, r.exitCode)
    );

    return new ShellPromise(promise);
  }

  $.exec = (command: string, options?: StreamingExecOptions): ShellPromise => {
    if (options?.onStdout || options?.onStderr) {
      // Streaming mode: bypass just-bash and call transport directly
      // so chunks are delivered as they arrive.
      const [cmd, ...args] = parseCommand(command);
      const promise = transport
        .exec(cmd!, args, {
          onStdout: options.onStdout,
          onStderr: options.onStderr,
        })
        .then((r) => new ShellResult(r.stdout, r.stderr, r.exitCode));
      return new ShellPromise(promise);
    }
    const promise = bash.exec(command).then(
      (r) => new ShellResult(r.stdout, r.stderr, r.exitCode)
    );
    return new ShellPromise(promise);
  };
  $.writeFile = (remotePath: string, data: Uint8Array) => transport.writeFile(remotePath, data);
  $.readFile = (remotePath: string) => transport.readFile(remotePath);
  $.close = () => transport.close();
  $.transport = transport;

  return $ as GatewayShell;
}

const Gateway = { connect };
export default Gateway;
