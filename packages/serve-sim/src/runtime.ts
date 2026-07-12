/** Node runtime helpers for the bundled CLI. */
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import type { Socket } from "net";
import { createConnection, createServer as createNetServer, type Server as NetServer } from "net";

export function dirnameOf(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}

/** Block the current thread for `ms` milliseconds without busy-waiting. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Briefly bind to `port` to test whether it's available. */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
}

export interface PreviewServer {
  stop(force?: boolean): void;
}

/** Connect-style middleware signature, matching what `simMiddleware` returns. */
type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => Promise<void>,
) => Promise<void>;

type PreviewMiddleware = ConnectMiddleware & {
  handleUpgrade?: (req: IncomingMessage, socket: Socket, head: Buffer) => void;
};

function parseHttpRequestHead(buffer: Buffer): {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string | string[]>;
  headEnd: number;
} | null {
  const headEnd = buffer.indexOf("\r\n\r\n");
  if (headEnd === -1) return null;
  const lines = buffer.subarray(0, headEnd).toString("latin1").split("\r\n");
  const [method, url, version] = (lines.shift() ?? "").split(" ");
  if (!method || !url || !version?.startsWith("HTTP/")) return null;
  const headers: Record<string, string | string[]> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers[name];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (existing != null) {
      headers[name] = [existing, value];
    } else {
      headers[name] = value;
    }
  }
  return {
    method,
    url,
    httpVersion: version.slice("HTTP/".length),
    headers,
    headEnd: headEnd + 4,
  };
}

function isWebSocketUpgrade(headers: Record<string, string | string[]>): boolean {
  const upgrade = headers.upgrade;
  const connection = headers.connection;
  const upgradeValue = Array.isArray(upgrade) ? upgrade.join(",") : upgrade ?? "";
  const connectionValue = Array.isArray(connection) ? connection.join(",") : connection ?? "";
  return /websocket/i.test(upgradeValue) && /upgrade/i.test(connectionValue);
}

function proxyTcpToHttpServer(socket: Socket, firstChunk: Buffer, port: number): void {
  const upstream = createConnection(port, "127.0.0.1");
  const destroyBoth = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on("error", destroyBoth);
  upstream.on("error", destroyBoth);
  upstream.on("connect", () => {
    upstream.write(firstChunk);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
}

function createPreviewFrontServer(
  middleware: PreviewMiddleware,
  internalPort: number,
): NetServer {
  return createNetServer((socket) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 64 * 1024) {
        socket.destroy();
        return;
      }
      const parsed = parseHttpRequestHead(buffered);
      if (!parsed) return;
      socket.removeListener("data", onData);
      const pathname = new URL(parsed.url, "http://serve-sim.local").pathname;
      const isExecUpgrade = pathname === "/exec-ws" || pathname.endsWith("/exec-ws");
      if (middleware.handleUpgrade && isWebSocketUpgrade(parsed.headers) && !isExecUpgrade) {
        const head = buffered.subarray(parsed.headEnd);
        const req = {
          method: parsed.method,
          url: parsed.url,
          headers: parsed.headers,
          httpVersion: parsed.httpVersion,
          socket,
        } as IncomingMessage;
        middleware.handleUpgrade(req, socket, head);
        return;
      }
      proxyTcpToHttpServer(socket, buffered, internalPort);
    };
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
  });
}

/** Run a Connect-style middleware as an HTTP server. */
export async function servePreview(opts: {
  port: number;
  middleware: PreviewMiddleware;
  /**
   * Interface to bind. Defaults to `127.0.0.1` so the preview is reachable
   * only from the developer's machine — the middleware exposes shell-exec
   * routes that must not be reachable from other hosts. Pass an explicit
   * value (e.g. `"0.0.0.0"`) to opt in to LAN exposure.
   */
  host?: string;
}): Promise<PreviewServer> {
  const isBun = !!process.versions.bun

  const internalServer = createHttpServer(
    {
      highWaterMark: 1024 * 1024 * 5,
    },
    async (req, res) => {
      try {
        return await opts.middleware(req, res, async () => {
          if (!res.headersSent) res.statusCode = 404;
          res.end("Not found");
        });
      } catch (err) {
        console.error("Middleware error:", err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        } else {
          res.end();
        }
      }
    }
  );
  // MJPEG streams + SSE log channel are long-lived; clear the default 2-min
  // socket timeout so they don't get torn down mid-stream.
  internalServer.keepAliveTimeout = 0;
  internalServer.headersTimeout = 0;
  internalServer.requestTimeout = 0;
  internalServer.timeout = 0;
  internalServer.on("upgrade", (req, socket, head) => {
    if (opts.middleware.handleUpgrade) {
      opts.middleware.handleUpgrade(req, socket as Socket, head);
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error & { code?: string }) => {
      internalServer.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      internalServer.removeListener("error", onError);
      resolve();
    };
    internalServer.once("error", onError);
    internalServer.once("listening", onListening);
    if (isBun) {
      internalServer.listen(0, "127.0.0.1");
    } else {
      internalServer.listen(opts.port, opts.host ?? "127.0.0.1");
    }
  });

  const internalAddress = internalServer.address();
  if (!internalAddress || typeof internalAddress === "string") {
    internalServer.close();
    throw new Error("Failed to bind preview HTTP server");
  }

  let maybeFrontServer: NetServer | undefined;
  if (isBun) {
    // works around a bug where Bun fails to proxy websockets
    // https://github.com/oven-sh/bun/issues/14522
    const frontServer = createPreviewFrontServer(opts.middleware, internalAddress.port);
    maybeFrontServer = frontServer;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error & { code?: string }) => {
        frontServer.removeListener("listening", onListening);
        // The internal server is already listening; if the front fails to bind
        // (e.g. EADDRINUSE during the port-scan retry loop), close it too so we
        // don't leak a listener per attempt.
        internalServer.close(() => reject(err));
      };
      const onListening = () => {
        frontServer.removeListener("error", onError);
        resolve();
      };
      frontServer.once("error", onError);
      frontServer.once("listening", onListening);
      frontServer.listen(opts.port, opts.host ?? "127.0.0.1");
    });
  }

  return {
    stop: () => {
      internalServer.close()
      maybeFrontServer?.close()
    },
  };
}
