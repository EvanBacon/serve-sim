/**
 * Small fixed host actions that make a remote (tunneled) simulator usable
 * from another machine, e.g. Linux:
 *
 * - `POST /openurl?device=<udid>` `{url}` → `xcrun simctl openurl <udid> <url>`
 * - `GET /helper/<udid>/screenshot[?format=png]` → one still frame
 *
 * Both sit behind the same auth gate as every other preview route. Neither
 * is a shell: the argv is fixed and the URL is validated first. `/openurl`
 * is not gated on `--allow-exec`.
 */
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { readFile, rm } from "fs/promises";
import type { IncomingMessage, ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";

const OPEN_URL_MAX_LENGTH = 8192;
const OPEN_URL_BODY_LIMIT = OPEN_URL_MAX_LENGTH * 2 + 1024;
const UDID_RE = /^[0-9A-Fa-f-]{8,64}$/;
// Schemes that could reach host files or run script in a page context.
const BLOCKED_SCHEMES = new Set(["file:", "javascript:", "data:", "vbscript:", "blob:"]);

/**
 * Validate a URL for `simctl openurl`. Any absolute URL with a scheme
 * (https, custom app schemes such as `exp://`) is allowed except file/script
 * schemes. Returns the trimmed URL or an error message.
 */
export function validateOpenUrl(input: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "url must be a string" };
  const url = input.trim();
  if (url === "") return { ok: false, error: "url is empty" };
  if (url.length > OPEN_URL_MAX_LENGTH) return { ok: false, error: `url is longer than ${OPEN_URL_MAX_LENGTH} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return { ok: false, error: "url contains whitespace or control characters" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
  if (!scheme) return { ok: false, error: "url needs a scheme, e.g. https://example.com or myapp://path" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "url is not a valid absolute URL" };
  }
  if (BLOCKED_SCHEMES.has(parsed.protocol)) return { ok: false, error: `${parsed.protocol} URLs are not allowed` };
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.hostname) {
    return { ok: false, error: "url has no host" };
  }
  return { ok: true, url };
}

export type HostRunner = (file: string, args: readonly string[], opts: { maxBuffer?: number }) => Promise<{ stdout: Buffer }>;

const defaultRunner: HostRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "buffer", maxBuffer: opts.maxBuffer ?? 1024 * 1024, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : String(stderr ?? "").trim();
        reject(new Error(detail || err.message));
        return;
      }
      resolve({ stdout: stdout as Buffer });
    });
  });

function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function isJson(value: string | undefined): boolean {
  return (value ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

export interface OpenUrlRouteOptions {
  /** `simctl` argv prefix for the active device set, e.g. `["simctl", "--set", p]`. */
  simctlArgs: (args: readonly string[]) => string[];
  servesDevice: (udid: string) => Promise<boolean>;
  run?: HostRunner;
  onResult?: (udid: string, url: string, error?: string) => void;
}

/** `POST /openurl?device=<udid>` with `{"url": "..."}` (JSON only). */
export function createOpenUrlRoute(options: OpenUrlRouteOptions) {
  const run = options.run ?? defaultRunner;
  return (req: IncomingMessage, res: ServerResponse, device: string | null): void => {
    if (!isJson(req.headers["content-type"])) {
      reply(res, 415, { ok: false, error: "unsupported_media_type" });
      req.resume();
      return;
    }
    if (!device || !UDID_RE.test(device)) {
      reply(res, 400, { ok: false, error: "invalid_device" });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > OPEN_URL_BODY_LIMIT) {
        tooLarge = true;
        reply(res, 413, { ok: false, error: "payload_too_large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (tooLarge) return;
      let raw: unknown;
      try {
        raw = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { url?: unknown } | null)?.url;
      } catch {
        reply(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const checked = validateOpenUrl(raw);
      if (!checked.ok) {
        reply(res, 400, { ok: false, error: "invalid_url", detail: checked.error });
        return;
      }
      try {
        if (!(await options.servesDevice(device))) {
          reply(res, 404, { ok: false, error: "unknown_device" });
          return;
        }
        // `--` is not needed: simctl takes the URL positionally and it starts with a scheme.
        await run("xcrun", options.simctlArgs(["openurl", device, checked.url]), {});
        options.onResult?.(device, checked.url);
        reply(res, 200, { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.onResult?.(device, checked.url, message);
        reply(res, 502, { ok: false, error: "openurl_failed", detail: message });
      }
    });
  };
}

export type ScreenshotFormat = "jpeg" | "png";

export function parseScreenshotFormat(value: string | null | undefined): ScreenshotFormat | undefined {
  if (value == null || value === "") return "jpeg";
  const v = value.toLowerCase();
  if (v === "jpeg" || v === "jpg") return "jpeg";
  if (v === "png") return "png";
  return undefined;
}

export interface ScreenshotRouteDeps {
  /** One JPEG from the live capture pipeline (no rolling buffer needed). */
  snapshotJpeg: () => Promise<Uint8Array | null>;
  simctlArgs: (args: readonly string[]) => string[];
  run?: HostRunner;
  /** Where the PNG is written before it is sent. Default: `os.tmpdir()`. */
  tmpDir?: string;
  readFile?: (path: string) => Promise<Uint8Array>;
}

/**
 * Full-resolution PNG via `simctl io <udid> screenshot`. simctl's help says
 * `-` means stdout, but it writes a file named `-`; use a private temp file.
 */
async function simctlScreenshotPng(device: string, deps: ScreenshotRouteDeps): Promise<Uint8Array> {
  const path = join(deps.tmpDir ?? tmpdir(), `serve-sim-screenshot-${randomUUID()}.png`);
  try {
    await (deps.run ?? defaultRunner)("xcrun", deps.simctlArgs(["io", device, "screenshot", "--type=png", path]), {});
    return await (deps.readFile ?? readFile)(path);
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

/**
 * `GET /helper/<udid>/screenshot` → `image/jpeg` from the capture pipeline;
 * `?format=png` → a full-resolution PNG from `simctl io screenshot`.
 */
export async function handleScreenshotRequest(
  req: IncomingMessage,
  res: ServerResponse,
  device: string,
  deps: ScreenshotRouteDeps,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    reply(res, 405, { error: "method_not_allowed" });
    return;
  }
  const format = parseScreenshotFormat(new URL(req.url ?? "", "http://x").searchParams.get("format"));
  if (!format) {
    reply(res, 400, { error: "invalid_format", message: "format must be jpeg or png" });
    return;
  }
  let bytes: Uint8Array | null;
  try {
    if (format === "png") {
      bytes = await simctlScreenshotPng(device, deps);
    } else {
      bytes = await deps.snapshotJpeg();
    }
  } catch (err) {
    reply(res, 502, { error: "screenshot_failed", message: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!bytes || bytes.length === 0) {
    reply(res, 503, { error: "no_frame", message: "No frame captured yet; try again in a moment" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": format === "png" ? "image/png" : "image/jpeg",
    "Content-Length": String(bytes.length),
    "Cache-Control": "no-store",
  });
  res.end(method === "HEAD" ? undefined : bytes);
}
