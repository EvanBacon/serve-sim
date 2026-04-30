/**
 * Cross-runtime helpers — keep `index.ts` working under both Bun and Node.
 *
 * The runtime is detected at load time by looking for `globalThis.Bun`. Each
 * helper picks the Bun-native API when available (preserving the original
 * behavior for users who keep `bun` on their PATH) and falls back to a Node
 * stdlib equivalent otherwise.
 */
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { createServer as createNetServer } from "net";

declare const Bun: any;
const bun: any = (globalThis as any).Bun;
export const hasBunRuntime: boolean = typeof bun !== "undefined";

/** Node-friendly equivalent of `import.meta.dir`. Pass `import.meta.url`. */
export function dirnameOf(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}

/**
 * Block the current thread for `ms` milliseconds without busy-waiting.
 * Uses `Bun.sleepSync` when available, otherwise `Atomics.wait` on a
 * SharedArrayBuffer (works on both Node 16+ and Bun).
 */
export function sleepSync(ms: number): void {
  if (hasBunRuntime && typeof bun.sleepSync === "function") {
    bun.sleepSync(ms);
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Briefly bind to `port` to test whether it's available. Returns true on
 * success. Mirrors the original `Bun.serve({...}); server.stop(true);`
 * probe — uses `node:net` when running outside Bun.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (hasBunRuntime && typeof bun.serve === "function") {
    try {
      const server = bun.serve({ port, fetch: () => new Response("ok") });
      server.stop(true);
      return true;
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

export interface PreviewServer {
  stop(force?: boolean): void;
}

/** Connect-style middleware signature, matching what `simMiddleware` returns. */
type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

/**
 * Run a Connect-style middleware as an HTTP server. On Bun, uses `Bun.serve`
 * with a Node-style req/res shim (preserving the original behavior). On Node,
 * uses `node:http` directly — the middleware is already Node-shaped, so no
 * shim is needed.
 *
 * `idleTimeout: 255` matches the Bun-side default and is load-bearing for
 * long-lived MJPEG streams.
 *
 * Returns a Promise that resolves once the server is listening. EADDRINUSE
 * (and other bind errors) reject the promise so callers can retry with the
 * next port — Bun.serve throws synchronously, but `node:http` listen errors
 * arrive asynchronously, so we normalize to async on both runtimes.
 */
export async function servePreview(opts: {
  port: number;
  middleware: ConnectMiddleware;
}): Promise<PreviewServer> {
  if (hasBunRuntime && typeof bun.serve === "function") {
    const server = bun.serve({
      port: opts.port,
      idleTimeout: 255,
      async fetch(req: Request) {
        // Methods that may carry a body get it pre-read here so the shim can
        // replay it as Node-style "data"/"end" events. Without this, any
        // middleware that reads `req.on("data"/"end")` hangs forever — which
        // was silently breaking the /exec endpoint the client uses to run
        // simctl (device picker stayed empty, header stuck on "No simulator").
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const bodyBuf = hasBody ? new Uint8Array(await req.arrayBuffer()) : null;
        return new Promise<Response>((resolve) => {
          const url = new URL(req.url);
          const listeners: Record<string, Array<(arg?: any) => void>> = {};
          const nodeReq: any = {
            url: url.pathname + url.search,
            method: req.method,
            headers: Object.fromEntries(req.headers.entries()),
            on(event: string, cb: (arg?: any) => void) {
              (listeners[event] ??= []).push(cb);
            },
          };
          req.signal.addEventListener("abort", () => {
            for (const cb of listeners.close ?? []) cb();
          });

          let statusCode = 200;
          const resHeaders = new Headers();
          const bodyParts: (string | Uint8Array)[] = [];
          let streaming = false;
          let streamController: ReadableStreamDefaultController | null = null;

          const nodeRes: any = {
            writeHead(code: number, headers?: Record<string, string>) {
              statusCode = code;
              if (headers) {
                for (const [k, v] of Object.entries(headers)) resHeaders.set(k, v);
              }
            },
            setHeader(k: string, v: string) { resHeaders.set(k, v); },
            get statusCode() { return statusCode; },
            set statusCode(c: number) { statusCode = c; },
            write(chunk: string | Uint8Array) {
              if (!streaming) {
                streaming = true;
                const stream = new ReadableStream({
                  start(ctrl) { streamController = ctrl; },
                });
                resolve(new Response(stream, { status: statusCode, headers: resHeaders }));
              }
              try {
                streamController?.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
              } catch {}
            },
            end(body?: string | Uint8Array) {
              if (streaming) {
                if (body) {
                  try {
                    streamController?.enqueue(typeof body === "string" ? new TextEncoder().encode(body) : body);
                  } catch {}
                }
                try { streamController?.close(); } catch {}
              } else {
                if (body) bodyParts.push(body);
                const fullBody = bodyParts
                  .map((p) => (typeof p === "string" ? p : new TextDecoder().decode(p)))
                  .join("");
                resolve(new Response(fullBody, { status: statusCode, headers: resHeaders }));
              }
            },
          };

          opts.middleware(nodeReq, nodeRes, () => {
            resolve(new Response("Not found", { status: 404 }));
          });

          queueMicrotask(() => {
            if (bodyBuf && bodyBuf.length > 0) {
              const chunk = Buffer.from(bodyBuf);
              for (const cb of listeners.data ?? []) cb(chunk);
            }
            for (const cb of listeners.end ?? []) cb();
          });
        });
      },
    });
    return { stop: (force?: boolean) => server.stop(force) };
  }

  // Node fallback — middleware already speaks the Node req/res shape, so no
  // shim is required.
  const server = createHttpServer((req, res) => {
    opts.middleware(req, res, () => {
      if (!res.headersSent) res.statusCode = 404;
      res.end("Not found");
    });
  });
  // MJPEG streams + SSE log channel are long-lived; clear the default 2-min
  // socket timeout so they don't get torn down mid-stream.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error & { code?: string }) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port);
  });

  return { stop: () => server.close() };
}
