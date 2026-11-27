/**
 * `serve-sim --tunnel`: front the loopback preview with a Cloudflare quick
 * tunnel (`cloudflared tunnel --url http://127.0.0.1:<port>`, free, no
 * account) and print a copy-paste recipe for the agent machine.
 *
 * Everything here is injectable (spawn, PATH lookup) so it can be unit tested
 * without the network or a real `cloudflared`.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "child_process";
import { randomBytes } from "crypto";
import { accessSync, constants as fsConstants, statSync } from "fs";
import { delimiter, join } from "path";

export const CLOUDFLARED_INSTALL_HINT =
  "cloudflared is not installed (or not on PATH). Install it with `brew install cloudflared` " +
  "(no Cloudflare account needed), or front the preview yourself and pass --public-origin <https://...>.";

/** 32 random bytes, base64url: a fresh bearer token per `--tunnel` run. */
export function generateAuthToken(bytes: () => Buffer = () => randomBytes(32)): string {
  return bytes().toString("base64url");
}

/** First executable `name` on `PATH`, or undefined. */
function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/**
 * Validate `--public-origin`: an http(s) origin with no path, query,
 * fragment or credentials. Returns `scheme://host[:port]`.
 */
export function normalizePublicOrigin(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid --public-origin: ${raw || "(empty)"}. Pass e.g. https://example.trycloudflare.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`--public-origin must be an http(s) URL, got ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`--public-origin must be a bare origin like https://example.trycloudflare.com (got ${raw})`);
  }
  return url.origin;
}

/** The host:port cloudflared should forward to for a preview bound to `host`. */
export function tunnelTargetUrl(host: string, port: number): string {
  const h = host.trim().toLowerCase();
  if (h === "" || h === "0.0.0.0" || h === "::" || h === "[::]" || h === "localhost" || h === "127.0.0.1") {
    return `http://127.0.0.1:${port}`;
  }
  const bare = h.replace(/^\[|\]$/g, "");
  return `http://${bare.includes(":") ? `[${bare}]` : bare}:${port}`;
}

const QUICK_TUNNEL_RE = /https:\/\/(?!api\.)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com\b/i;
const ANY_HTTPS_RE = /https:\/\/[a-z0-9.-]+(?::\d+)?\b/i;

/**
 * Incremental parser for cloudflared's log output. cloudflared prints the
 * quick tunnel URL inside a banner ("Your quick Tunnel has been created!
 * Visit it at ...") on stderr. Feed it lines from stdout and stderr.
 */
export class TunnelLogParser {
  private sawBanner = false;
  private lastError: string | undefined;

  /** Returns the public origin once found. */
  feed(line: string): string | undefined {
    const quick = QUICK_TUNNEL_RE.exec(line);
    if (quick) return new URL(quick[0]).origin;
    if (/visit it at/i.test(line)) {
      this.sawBanner = true;
      return undefined;
    }
    if (this.sawBanner) {
      const any = ANY_HTTPS_RE.exec(line);
      if (any) return new URL(any[0]).origin;
    }
    if (/\b(ERR|error|failed)\b/i.test(line)) this.lastError = line.replace(/^\S+\s+ERR\s+/, "").trim();
    return undefined;
  }

  /** The last error-looking line, for a failure message. */
  error(): string | undefined {
    return this.lastError;
  }
}

interface QuickTunnel {
  publicOrigin: string;
  child: ChildProcess;
  /** Stop cloudflared. Safe to call more than once and from an `exit` handler. */
  stop(): void;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

interface StartQuickTunnelOptions {
  targetUrl: string;
  /** Absolute path to cloudflared (see {@link findOnPath}). */
  bin: string;
  spawn?: SpawnFn;
  /** How long to wait for the public URL. Default 30 s. */
  timeoutMs?: number;
  /** Called right after spawn with a stop function, so an exit handler covers startup too. */
  onSpawn?: (stop: () => void) => void;
  /** Called if cloudflared exits after the tunnel came up. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** cloudflared arguments for a quick tunnel to `targetUrl`. */
export function quickTunnelArgs(targetUrl: string): string[] {
  return ["tunnel", "--no-autoupdate", "--url", targetUrl];
}

/** Spawn cloudflared and resolve once it prints the public origin. */
export function startQuickTunnel(opts: StartQuickTunnelOptions): Promise<QuickTunnel> {
  const spawn = opts.spawn ?? (nodeSpawn as SpawnFn);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.bin, quickTunnelArgs(opts.targetUrl), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(spawnError(err));
      return;
    }
    const parser = new TunnelLogParser();
    let settled = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { child.kill("SIGTERM"); } catch {}
    };
    opts.onSpawn?.(stop);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(err);
    };
    const timer = setTimeout(() => {
      const detail = parser.error();
      fail(new Error(`cloudflared did not report a tunnel URL within ${Math.round(timeoutMs / 1000)}s${detail ? `: ${detail}` : ""}`));
    }, timeoutMs);

    const onLine = (line: string) => {
      if (settled) return;
      const origin = parser.feed(line);
      if (!origin) return;
      settled = true;
      clearTimeout(timer);
      resolve({ publicOrigin: origin, child, stop });
    };
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let buffered = "";
      stream.setEncoding?.("utf8");
      stream.on("data", (chunk: string | Buffer) => {
        buffered += String(chunk);
        let nl: number;
        while ((nl = buffered.indexOf("\n")) !== -1) {
          onLine(buffered.slice(0, nl));
          buffered = buffered.slice(nl + 1);
        }
      });
    }
    child.on("error", (err) => fail(spawnError(err)));
    child.on("exit", (code, signal) => {
      if (!settled) {
        const detail = parser.error();
        fail(new Error(`cloudflared exited (${signal ?? `code ${code}`}) before the tunnel came up${detail ? `: ${detail}` : ""}`));
        return;
      }
      if (!stopped) opts.onExit?.(code, signal);
    });
  });
}

function spawnError(err: unknown): Error {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return new Error(CLOUDFLARED_INSTALL_HINT);
  return err instanceof Error ? err : new Error(String(err));
}

/** The banner `--tunnel` prints once the public origin is known. */
export function formatTunnelBanner(info: { localUrl: string; publicOrigin: string; token: string; generated: boolean; quick: boolean }): string {
  const { localUrl, publicOrigin, token } = info;
  const lines = [
    "",
    `  - Local:   ${localUrl}`,
    `  - Public:  ${publicOrigin}${info.quick ? " \x1b[2m(quick tunnel; can take a few seconds to resolve)\x1b[0m" : ""}`,
    `  - Viewer:  ${publicOrigin}/#token=${token}`,
    `  - Token:   ${token}${info.generated ? " \x1b[2m(new each run; pass --auth-token to pin one)\x1b[0m" : ""}`,
    "",
    "  On the agent machine (Linux works too):",
    "",
    `    export SERVE_SIM_AUTH_TOKEN=${token}`,
    `    serve-sim connect ${publicOrigin}`,
    "    serve-sim tap 0.5 0.5",
    "",
    "  Anyone with the token can control this simulator. Ctrl+C stops the preview and the tunnel.",
    "",
  ];
  return lines.join("\n");
}

export interface TunnelPlan {
  token: string;
  /** True when serve-sim generated the token for this run. */
  generated: boolean;
  /** `--public-origin`: reuse an existing tunnel instead of spawning cloudflared. */
  publicOrigin?: string;
  /** cloudflared path, when serve-sim starts the quick tunnel. */
  cloudflared?: string;
}

/**
 * Decide how `--tunnel` / `--public-origin` will run, before the preview
 * starts (so a missing cloudflared fails fast). Throws a user-facing error.
 * Sets `env[tokenEnv]` like `--auth-token` does, so request-trust protects
 * every route with it.
 */
export function planTunnel(opts: {
  explicitToken?: string;
  publicOrigin?: string;
  env: NodeJS.ProcessEnv;
  tokenEnv: string;
  findBin?: (name: string) => string | undefined;
  newToken?: () => string;
}): TunnelPlan {
  const publicOrigin = opts.publicOrigin !== undefined ? normalizePublicOrigin(opts.publicOrigin) : undefined;
  let cloudflared: string | undefined;
  if (!publicOrigin) {
    cloudflared = (opts.findBin ?? ((n) => findOnPath(n, opts.env)))("cloudflared");
    if (!cloudflared) throw new Error(CLOUDFLARED_INSTALL_HINT);
  }
  const existing = (opts.explicitToken ?? opts.env[opts.tokenEnv] ?? "").trim();
  const token = existing || (opts.newToken ?? generateAuthToken)();
  opts.env[opts.tokenEnv] = token;
  return { token, generated: !existing, publicOrigin, cloudflared };
}

/**
 * The `serve()` hook that runs once the preview is listening: start (or
 * adopt) the tunnel and print the connect recipe. cloudflared is stopped on
 * process exit; if it dies on its own, `onTunnelLost` runs.
 */
export function tunnelOnListening(plan: TunnelPlan, opts: {
  host: string;
  log: (text: string) => void;
  onExit: (handler: () => void) => void;
  onTunnelLost: (message: string) => void;
  spawn?: SpawnFn;
  timeoutMs?: number;
}): (port: number) => Promise<void> {
  return async (port) => {
    const target = tunnelTargetUrl(opts.host, port);
    let publicOrigin = plan.publicOrigin;
    if (!publicOrigin) {
      opts.log(`  Starting cloudflared quick tunnel to ${target}...`);
      const tunnel = await startQuickTunnel({
        bin: plan.cloudflared!,
        targetUrl: target,
        spawn: opts.spawn,
        timeoutMs: opts.timeoutMs,
        onSpawn: (stop) => opts.onExit(stop),
        onExit: (code, signal) =>
          opts.onTunnelLost(`cloudflared exited (${signal ?? `code ${code}`}); the tunnel is down. Restart \`serve-sim --tunnel\`.`),
      });
      publicOrigin = tunnel.publicOrigin;
    }
    opts.log(formatTunnelBanner({
      localUrl: target.replace("127.0.0.1", "localhost"),
      publicOrigin,
      token: plan.token,
      generated: plan.generated,
      quick: !plan.publicOrigin,
    }));
  };
}
