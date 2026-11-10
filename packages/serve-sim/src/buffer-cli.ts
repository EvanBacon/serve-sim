/**
 * `serve-sim buffer …`: drive the opt-in rolling frame buffer on a running
 * server (see rolling-buffer.ts for what it stores).
 *
 *   buffer [status]                  JSON: enabled, options, stats
 *   buffer start [--seconds N] [--fps N] [--size PX] [--quality Q] [--max-mb N]
 *   buffer stop                      stop and free the frames
 *   buffer list [--since 5s] [--json]
 *                                    changed frames + input, relative to now
 *   buffer frame [--id N | --ago 2s] [-o out.jpg]
 *                                    one JPEG (stdout when piped, else a temp file)
 *   buffer dump [--since 5s] [-o dir]
 *                                    every frame + buffer.json (a new temp dir by default)
 *
 * Nothing is written to the current directory unless asked with `-o`.
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { parseInspectTime } from "./record-inspect";
import type { BufferEvent, BufferFrame, BufferSample, BufferStats, RollingBufferOptions } from "./rolling-buffer";

export const BUFFER_VERBS = ["status", "start", "stop", "list", "frame", "dump"] as const;
export type BufferVerb = (typeof BUFFER_VERBS)[number];

export type BufferCliOptions = {
  seconds?: string;
  fps?: string;
  size?: string;
  quality?: string;
  maxMb?: string;
  since?: string;
  json?: boolean;
  id?: string;
  ago?: string;
  output?: string;
};

export type BufferCliDeps = {
  /** The target's HID socket URL (`…/helper/<udid>/ws`). */
  wsUrl: string;
  headers: Record<string, string>;
  fetch: (input: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<Response>;
  log: (line: string) => void;
  error: (line: string) => void;
  writeStdout: (bytes: Uint8Array) => void;
  stdoutIsTTY: boolean;
  tmpdir: () => string;
};

type ServerView = {
  enabled: boolean;
  options?: RollingBufferOptions;
  startedAt?: string;
  stats?: BufferStats & { maxBytes: number };
  origin?: string | null;
  now?: string;
  samples?: BufferSample[];
  frames?: BufferFrame[];
  events?: BufferEvent[];
};

/**
 * `…/buffer[/action][?params]` for an input target, from its HID socket URL.
 * @lintignore Exported for tests.
 */
export function bufferUrlForWsUrl(
  wsUrl: string,
  action?: "start" | "stop" | "frame",
  params: Record<string, string> = {},
): string | null {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/ws")) return null;
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.slice(0, -"ws".length) + (action ? `buffer/${action}` : "buffer");
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Human-readable listing: changed frames and input in time order, as seconds before now.
 * @lintignore Exported for tests.
 */
export function formatBufferView(view: ServerView): string {
  if (!view.enabled || !view.options) {
    return "The rolling buffer is off. Start it with `serve-sim buffer start` (or run the server with --buffer).";
  }
  const { options, stats } = view;
  const lines = [
    `Rolling buffer: ${options.seconds} s window at ${options.fps} fps, ${options.maxDimension} px JPEG q${options.quality}` +
      (stats ? ` — ${stats.frames} frames, ${kb(stats.bytes)} of ${mb(stats.maxBytes)} (${stats.samples} samples)` : ""),
  ];
  if (!view.origin || !view.now || !view.samples?.length) {
    lines.push("  (no frames yet)");
    return lines.join("\n");
  }
  const nowSec = (Date.parse(view.now) - Date.parse(view.origin)) / 1000;
  const ago = (t: number) => `${(t - nowSec).toFixed(2)}s`.padStart(8);
  const frames = new Map((view.frames ?? []).map((f) => [f.id, f]));
  type Row = { t: number; order: number; text: string };
  const rows: Row[] = [];
  const first = view.samples[0]!;
  for (const sample of view.samples) {
    if (!sample.changed && sample !== first) continue;
    const frame = frames.get(sample.frame);
    const size = frame ? `${frame.width}x${frame.height}  ${kb(frame.bytes)}` : "";
    const note = sample.changed ? "" : "  (on screen at window start)";
    rows.push({ t: sample.t, order: 1, text: `${ago(sample.t)}  frame ${sample.frame}   ${size}${note}` });
  }
  for (const event of view.events ?? []) {
    const next = event.nextChange ? `  → frame ${event.nextChange.frame} after ${event.nextChange.after.toFixed(2)}s` : "  → no change since";
    const span = event.tEnd != null ? ` (${(event.tEnd - event.t).toFixed(2)}s)` : "";
    rows.push({ t: event.t, order: 0, text: `${ago(event.t)}  ${event.kind}${span}  ${event.summary}${next}` });
  }
  rows.sort((a, b) => a.t - b.t || a.order - b.order);
  for (const row of rows) lines.push(row.text);
  return lines.join("\n");
}

class CliError extends Error {}

/** A server error response, with its JSON `error` code when it had one. */
class HttpError extends CliError {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** Seconds from `5`, `5s`, `500ms`, or a CliError naming the flag. */
function seconds(flag: string, raw: string): string {
  const value = parseInspectTime(raw);
  if (value == null) throw new CliError(`buffer: ${flag}: expected seconds (e.g. 5, 2.5s, 500ms), got ${JSON.stringify(raw)}`);
  return String(value);
}

async function request(deps: BufferCliDeps, url: string | null, method = "GET"): Promise<Response> {
  if (!url) throw new CliError(`Cannot derive the buffer endpoint from ${deps.wsUrl}`);
  let res: Response;
  try {
    res = await deps.fetch(url, { method, headers: deps.headers });
  } catch (error) {
    throw new CliError(`Failed to reach serve-sim: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.ok) return res;
  if (res.status === 401 || res.status === 403) {
    throw new CliError(`serve-sim refused the request (HTTP ${res.status}). Pass --auth-token or set SERVE_SIM_AUTH_TOKEN to the server's token.`);
  }
  const text = await res.text().catch(() => "");
  let body: { error?: string; message?: string } | null = null;
  try { body = JSON.parse(text); } catch {}
  if (res.status === 404 && !body?.error) {
    throw new CliError("This serve-sim server does not support the rolling buffer; restart it with a newer serve-sim.");
  }
  throw new HttpError(`buffer request failed (HTTP ${res.status}): ${body?.message ?? body?.error ?? res.statusText}`, res.status, body?.error);
}

async function fetchView(deps: BufferCliDeps, since?: string): Promise<ServerView> {
  const params: Record<string, string> = since != null ? { since: seconds("--since", since) } : {};
  return await (await request(deps, bufferUrlForWsUrl(deps.wsUrl, undefined, params))).json() as ServerView;
}

async function fetchFrame(deps: BufferCliDeps, params: Record<string, string>): Promise<Uint8Array> {
  const res = await request(deps, bufferUrlForWsUrl(deps.wsUrl, "frame", params));
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * `serve-sim --buffer` found a server already running for the device: the
 * buffer default only reaches sessions that server creates itself, so start
 * it there. `value` is the `SERVE_SIM_BUFFER` value (on, or seconds). Never
 * throws; anything but a start (or the same buffer already on) is a stderr
 * warning, since the server itself is fine to reuse.
 */
export async function startBufferOnReusedServer(
  value: string,
  deps: Pick<BufferCliDeps, "wsUrl" | "headers" | "fetch" | "error">,
): Promise<boolean> {
  const params: Record<string, string> = /^\d+$/.test(value.trim()) ? { seconds: value.trim() } : {};
  const url = bufferUrlForWsUrl(deps.wsUrl, "start", params);
  const fallback = "run `serve-sim buffer start` to turn it on";
  if (!url) {
    deps.error(`[serve-sim] --buffer: cannot reach the existing server's buffer at ${deps.wsUrl}; ${fallback}`);
    return false;
  }
  let res: Response;
  let body: ServerView & { alreadyRunning?: boolean; error?: string; message?: string };
  try {
    res = await deps.fetch(url, { method: "POST", headers: deps.headers });
    body = await res.json().catch(() => ({ enabled: false }));
  } catch (error) {
    deps.error(`[serve-sim] --buffer: the existing server has no buffer (${error instanceof Error ? error.message : String(error)}); ${fallback}`);
    return false;
  }
  if (res.ok && body.options) {
    if (!body.alreadyRunning) {
      deps.error(`  Buffer:    started on the existing server (last ${body.options.seconds} s; serve-sim buffer list)`);
    }
    return true;
  }
  if (res.status === 409 && body.error === "buffer_running" && body.options) {
    deps.error(
      `[serve-sim] --buffer: the existing server's buffer already runs with other options (${body.options.seconds} s at ${body.options.fps} fps); ` +
        "`serve-sim buffer stop` then `serve-sim buffer start` to change it",
    );
    return false;
  }
  const reason = body.message ?? body.error ?? `HTTP ${res.status}`;
  deps.error(`[serve-sim] --buffer: the existing server has no buffer (${reason}); ${fallback}`);
  return false;
}

/** Run one `buffer` verb; resolves to the process exit code. */
export async function runBufferCommand(verb: BufferVerb, opts: BufferCliOptions, deps: BufferCliDeps): Promise<number> {
  try {
    switch (verb) {
      case "status": {
        const view = await fetchView(deps);
        const { enabled, options, startedAt, stats } = view;
        deps.log(JSON.stringify({ enabled, ...(options ? { options, startedAt, stats } : {}) }));
        return 0;
      }
      case "start": {
        const params: Record<string, string> = {};
        if (opts.seconds != null) params.seconds = opts.seconds;
        if (opts.fps != null) params.fps = opts.fps;
        if (opts.size != null) params.size = opts.size;
        if (opts.quality != null) params.quality = opts.quality;
        if (opts.maxMb != null) params.maxMB = opts.maxMb;
        const state = await (await request(deps, bufferUrlForWsUrl(deps.wsUrl, "start", params), "POST")).json() as ServerView;
        deps.log(JSON.stringify(state));
        if (state.options) {
          deps.error(
            `Buffering the last ${state.options.seconds} s at ${state.options.fps} fps (at most ${mb(state.options.maxBytes)}). ` +
              "Inspect with `serve-sim buffer list`; turn off with `serve-sim buffer stop`.",
          );
        }
        return 0;
      }
      case "stop": {
        deps.log(JSON.stringify(await (await request(deps, bufferUrlForWsUrl(deps.wsUrl, "stop"), "POST")).json()));
        return 0;
      }
      case "list": {
        const view = await fetchView(deps, opts.since);
        deps.log(opts.json ? JSON.stringify(view) : formatBufferView(view));
        return 0;
      }
      case "frame": {
        if (opts.id != null && opts.ago != null) throw new CliError("buffer frame: pass --id or --ago, not both");
        const params: Record<string, string> = {};
        if (opts.id != null) params.id = opts.id;
        if (opts.ago != null) params.ago = seconds("--ago", opts.ago);
        const jpeg = await fetchFrame(deps, params);
        if (opts.output && opts.output !== "-") {
          writeFileSync(resolve(opts.output), jpeg);
          deps.log(`Wrote ${resolve(opts.output)} (${kb(jpeg.length)})`);
        } else if (opts.output === "-" || !deps.stdoutIsTTY) {
          deps.writeStdout(jpeg);
        } else {
          const path = join(mkdtempSync(join(deps.tmpdir(), "serve-sim-buffer-frame-")), "frame.jpg");
          writeFileSync(path, jpeg);
          deps.log(`Wrote ${path} (${kb(jpeg.length)})`);
        }
        return 0;
      }
      case "dump": {
        const view = await fetchView(deps, opts.since);
        if (!view.enabled) throw new CliError("The rolling buffer is off; start it with `serve-sim buffer start`.");
        let target: string;
        if (opts.output) {
          target = resolve(opts.output);
          mkdirSync(target, { recursive: true });
          if (readdirSync(target).length > 0) throw new CliError(`buffer dump: ${target} is not empty`);
        } else {
          target = mkdtempSync(join(deps.tmpdir(), "serve-sim-buffer-"));
        }
        const frames = [];
        let missing = 0;
        for (const frame of view.frames ?? []) {
          let jpeg: Uint8Array;
          try {
            jpeg = await fetchFrame(deps, { id: String(frame.id) });
          } catch (error) {
            // Evicted (window or byte cap) since the view was read: keep going.
            if (!(error instanceof HttpError && error.status === 404 && error.code === "frame_not_found")) throw error;
            missing++;
            frames.push({ ...frame, missing: true });
            continue;
          }
          const file = `frame-${String(frame.id).padStart(4, "0")}.jpg`;
          writeFileSync(join(target, file), jpeg);
          frames.push({ ...frame, file });
        }
        writeFileSync(
          join(target, "buffer.json"),
          JSON.stringify({ ...view, frames, ...(missing ? { missingFrames: missing } : {}) }, null, 2) + "\n",
        );
        const note = missing ? ` (${missing} evicted before download, marked missing)` : "";
        deps.log(`Wrote ${frames.length - missing} frames${note} + buffer.json to ${target}`);
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof CliError) {
      deps.error(error.message);
      return 1;
    }
    deps.error(`buffer ${verb}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
