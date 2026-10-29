import type { IncomingMessage } from "http";

/**
 * POST bodies the routes cap: `/reload` only carries `{ bundleId }`, and
 * exec's cap is a belt-and-braces guard so a runaway POST can't OOM the dev
 * server. Other routes read the whole body.
 */
const BODY_LIMIT_BYTES: Readonly<Record<string, number>> = {
  "/reload": 4 * 1024,
  "/exec": 4 * 1024 * 1024,
  "/exec/": 4 * 1024 * 1024,
};

/** A POST body: over its route's cap (no longer read), or read and parsed once. */
export type RequestBody =
  | { kind: "too-large" }
  | { kind: "read"; text: string; json: { ok: true; value: unknown } | { ok: false; error: unknown } };

/**
 * One request to a path simMiddleware owns, parsed once before any route
 * runs: its URL, the simulators the URL names, and its body.
 */
export interface RequestContext {
  method: string;
  rawUrl: string;
  /** The path without its query, as the routes match it. */
  url: string;
  /** `?…`, or "" when there is none. */
  search: string;
  /** The path with dot segments and `//host` collapsed. */
  pathname: string;
  /** `?device=`. */
  requestedDevice: string | null;
  /** `?device=`, else the simulator the middleware is pinned to. */
  selectedDevice: string | null;
  /** A helper route and the path it forwards to. */
  helper: { device: string | null; upstreamPath: string } | null;
  /** The simulator a helper route acts on: its own, else the selected one. */
  helperDevice: string | null;
  /** DevTools routes, which reach every simulator. */
  devtools: boolean;
  /** The body, read on first call, within its route's cap. */
  body(): Promise<RequestBody>;
}

export function requestContext(
  req: IncomingMessage,
  mount: { base: string; device: string | undefined },
): RequestContext {
  const rawUrl = req.url ?? "";
  const qIndex = rawUrl.indexOf("?");
  const url = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const pathname = requestPathname(rawUrl);
  const requestedDevice = queryDevice(rawUrl);
  const selectedDevice = requestedDevice ?? mount.device ?? null;
  const helper = helperProxyTarget(rawUrl, helperProxyPrefix(mount.base));
  let body: Promise<RequestBody> | null = null;
  return {
    method: (req.method ?? "GET").toUpperCase(),
    rawUrl,
    url,
    search: qIndex === -1 ? "" : rawUrl.slice(qIndex),
    pathname,
    requestedDevice,
    selectedDevice,
    helper,
    helperDevice: helper ? helper.device ?? selectedDevice : null,
    devtools: pathname.startsWith(`${mount.base}/devtools`),
    body: () => (body ??= readBody(req, BODY_LIMIT_BYTES[url.slice(mount.base.length)] ?? Infinity)),
  };
}

/** The parsed JSON body; throws its parse error, or for a body over the cap. */
export function jsonValue(body: RequestBody): unknown {
  if (body.kind === "too-large") throw new Error("Body too large");
  if (!body.json.ok) throw body.json.error;
  return body.json.value;
}

/**
 * Count raw bytes, not decoded characters, so multibyte UTF-8 can't slip
 * past the cap; past it, resolve at once and drop the rest.
 */
function readBody(req: IncomingMessage, limitBytes: number): Promise<RequestBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer | string) => {
      if (bytes > limitBytes) return;
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += data.length;
      if (bytes > limitBytes) {
        chunks.length = 0;
        resolve({ kind: "too-large" });
        return;
      }
      chunks.push(data);
    });
    req.on("end", () => {
      if (bytes > limitBytes) return;
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve({ kind: "read", text, json: { ok: true, value: JSON.parse(text) } });
      } catch (error) {
        resolve({ kind: "read", text, json: { ok: false, error } });
      }
    });
  });
}

function queryDevice(rawUrl: string): string | null {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return null;
  return new URLSearchParams(rawUrl.slice(qIndex + 1)).get("device");
}

function helperProxyPrefix(base: string): string {
  return `${base === "/" ? "" : base}/helper`;
}

/** Pathname the routers already match on (dot-segments / `//host` collapsed). */
export function requestPathname(rawUrl: string): string {
  try {
    return new URL(rawUrl || "/", "http://serve-sim.local").pathname;
  } catch {
    const q = rawUrl.indexOf("?");
    return q === -1 ? rawUrl || "/" : rawUrl.slice(0, q) || "/";
  }
}

function helperProxyTarget(rawUrl: string, prefix: string): { device: string | null; upstreamPath: string } | null {
  const parsed = new URL(rawUrl, "http://serve-sim.local");
  if (parsed.pathname !== prefix && !parsed.pathname.startsWith(`${prefix}/`)) {
    return null;
  }
  const rawSuffix = parsed.pathname.slice(prefix.length);
  const segments = rawSuffix.replace(/^\/+/, "").split("/").filter(Boolean);
  const directHelperEndpoints = new Set([
    "ax",
    "config",
    "foreground",
    "health",
    "recording",
    "stream.avcc",
    "stream.mjpeg",
    "stream.3d.mjpeg",
    "ws",
  ]);
  let device = parsed.searchParams.get("device");
  let upstreamSegments = segments;
  if (segments[0] && !directHelperEndpoints.has(segments[0])) {
    device = decodeURIComponent(segments[0]);
    upstreamSegments = segments.slice(1);
  }
  const suffix = upstreamSegments.length > 0 ? `/${upstreamSegments.join("/")}` : "/";
  parsed.searchParams.delete("device");
  return { device, upstreamPath: `${suffix}${parsed.search}` };
}
