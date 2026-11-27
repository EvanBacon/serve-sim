/**
 * Client side of driving a remote serve-sim: `connect` / `disconnect` (the
 * saved profile) and the `screenshot` / `open` commands. Pure Node + fetch:
 * these run on Linux with no simctl or native addon.
 */
import { closeSync, openSync, writeSync } from "fs";
import { AUTH_TOKEN_ENV } from "./request-trust";
import {
  loadRemoteProfile,
  normalizeRemoteUrl,
  remoteProfilePath,
  removeRemoteProfile,
  saveRemoteProfile,
} from "./remote-profile";
import { parseScreenshotFormat, validateOpenUrl, type ScreenshotFormat } from "./remote-actions";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIo: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) };

export interface ConnectOptions {
  token?: string;
  check?: boolean;
  profilePath?: string;
  fetch?: typeof fetch;
  io?: CliIo;
}

/**
 * `serve-sim connect <url>`: validate, check `/api` with the token, then save
 * the URL (never the token). Returns the process exit code.
 */
export async function connectCommand(urlArg: string | undefined, opts: ConnectOptions = {}): Promise<number> {
  const io = opts.io ?? consoleIo;
  const path = opts.profilePath ?? remoteProfilePath();
  if (urlArg === undefined) {
    const current = loadRemoteProfile(path);
    if (current) io.out(`Connected to ${current.url} (saved ${current.savedAt || "earlier"}; ${path})`);
    else io.out("Not connected. Run `serve-sim connect <url>`.");
    return 0;
  }
  let url: string;
  try {
    url = normalizeRemoteUrl(urlArg);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const token = opts.token?.trim() || undefined;
  let device: string | undefined;
  if (opts.check !== false) {
    if (!token) {
      io.err(`warning: ${AUTH_TOKEN_ENV} is not set; a remote server will refuse commands until you export it.`);
    } else {
      const doFetch = opts.fetch ?? fetch;
      let res: Response;
      try {
        res = await doFetch(`${url}/api`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        io.err(
          `Failed to reach serve-sim at ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
            "A new quick tunnel can take a few seconds to resolve; retry, or pass --no-check to save it anyway.",
        );
        return 1;
      }
      if (res.status === 401 || res.status === 403) {
        io.err(
          `serve-sim at ${url} refused the token (HTTP ${res.status}). ` +
            `Export the token the server printed: export ${AUTH_TOKEN_ENV}=<token>. ` +
            "A restarted `serve-sim --tunnel` prints a new one.",
        );
        return 1;
      }
      if (!res.ok) {
        io.err(`serve-sim at ${url} returned HTTP ${res.status} for /api. Is this a serve-sim preview URL?`);
        return 1;
      }
      const body = (await res.json().catch(() => null)) as { device?: unknown } | null;
      device = typeof body?.device === "string" ? body.device : undefined;
    }
  }
  saveRemoteProfile(url, path);
  io.out(`Connected to ${url}${device ? ` (simulator ${device})` : ""}.`);
  io.out(`Commands like \`serve-sim tap 0.5 0.5\` now go there; \`serve-sim disconnect\` to stop. The token is not saved.`);
  return 0;
}

/** `serve-sim disconnect`: forget the saved profile. */
export function disconnectCommand(opts: { profilePath?: string; io?: CliIo } = {}): number {
  const io = opts.io ?? consoleIo;
  const removed = removeRemoteProfile(opts.profilePath ?? remoteProfilePath());
  io.out(removed ? `Disconnected from ${removed.url}.` : "Not connected.");
  return 0;
}

/** Enough of an input target to call the preview's HTTP routes. */
export interface HttpTarget {
  device: string;
  url: string;
  headers: Record<string, string>;
}

function routeUrl(target: HttpTarget, path: string): URL {
  return new URL(path, target.url.endsWith("/") ? target.url : `${target.url}/`);
}

/** Pick the format from `--format`, else the file extension, else JPEG. */
function screenshotFormatFor(file: string | undefined, format: string | undefined): ScreenshotFormat | undefined {
  if (format !== undefined) return parseScreenshotFormat(format);
  if (file && /\.png$/i.test(file)) return "png";
  return "jpeg";
}

function defaultScreenshotName(format: ScreenshotFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return `serve-sim-screenshot-${stamp}.${format === "png" ? "png" : "jpg"}`;
}

export interface ScreenshotOptions {
  file?: string;
  format?: string;
  /** Write to stdout instead of a file (default when stdout is not a TTY and no file is given). */
  toStdout?: boolean;
  fetch?: typeof fetch;
  io?: CliIo;
  writeStdout?: (bytes: Uint8Array) => void;
}

/** `serve-sim screenshot [file]`: fetch one frame and write it on this machine. */
export async function screenshotCommand(target: HttpTarget, opts: ScreenshotOptions): Promise<number> {
  const io = opts.io ?? consoleIo;
  const format = screenshotFormatFor(opts.file, opts.format);
  if (!format) {
    io.err(`Unsupported --format ${opts.format}. Use png or jpeg.`);
    return 1;
  }
  const url = routeUrl(target, `helper/${encodeURIComponent(target.device)}/screenshot`);
  if (format === "png") url.searchParams.set("format", "png");
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, { headers: target.headers, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    io.err(`Failed to reach serve-sim at ${url.origin}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    const hint = res.status === 404 ? " (is the server older than this CLI? update serve-sim on the Mac)" : "";
    io.err(`serve-sim screenshot failed (HTTP ${res.status}): ${body?.message ?? body?.error ?? "unknown error"}${hint}`);
    return 1;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (opts.toStdout && !opts.file) {
    (opts.writeStdout ?? ((b) => process.stdout.write(b)))(bytes);
    return 0;
  }
  const file = opts.file ?? defaultScreenshotName(format);
  const fd = openSync(file, "w");
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  io.out(file);
  return 0;
}

/** `serve-sim open <url>`: ask the host to `simctl openurl` on the target simulator. */
export async function openUrlCommand(target: HttpTarget, rawUrl: string, opts: { fetch?: typeof fetch; io?: CliIo } = {}): Promise<number> {
  const io = opts.io ?? consoleIo;
  const checked = validateOpenUrl(rawUrl);
  if (!checked.ok) {
    io.err(`Invalid URL: ${checked.error}`);
    return 1;
  }
  const url = routeUrl(target, "openurl");
  url.searchParams.set("device", target.device);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: { ...target.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ url: checked.url }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    io.err(`Failed to reach serve-sim at ${url.origin}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; detail?: string } | null;
  if (!res.ok || body?.ok !== true) {
    const hint = res.status === 404 && !body?.error ? " (is the server older than this CLI? update serve-sim on the Mac)" : "";
    io.err(`serve-sim open failed (HTTP ${res.status}): ${[body?.error, body?.detail].filter(Boolean).join(": ") || "unknown error"}${hint}`);
    return 1;
  }
  io.out(`Opened ${checked.url}`);
  return 0;
}
