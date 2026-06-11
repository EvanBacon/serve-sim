import { exec, type ExecException } from "child_process";
import { createHash, timingSafeEqual } from "crypto";
import { request as httpRequest, type IncomingMessage } from "http";
import type { Socket } from "net";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";

// WebSocket control channel for the preview page. Browsers cap HTTP/1.1 at
// six connections per origin, and every preview tab used to hold several
// long-lived requests (MJPEG + 3-4 SSE channels + pooled exec fetches) — with
// two or more tabs open, new requests queue behind them forever. This channel
// carries shell execs, simulator-settings requests, and multiplexed SSE
// subscriptions, so each tab needs just one pooled connection (the video
// stream) plus this socket.
//
// Built on `ws` rather than hand-rolled RFC6455: under Bun, `node:http`
// emits `upgrade` but raw 101 handshake writes to the socket never flush, so
// manual framing silently breaks — Bun instead substitutes its own native
// implementation for the `ws` module, which works. The client is
// intentionally WS-only (no HTTP fallback): a broken channel must surface as
// an error, not silent degradation.
//
// Wire protocol (all JSON text frames):
//   client → {token}                  first frame; must match the exec token
//   server → {ready:true}             auth accepted
//   client → {id, command}            run a shell command
//   server → {id, stdout, stderr, exitCode}
//   client → {id, ui:{…}}             simulator-settings request (in-process,
//   server → {id, …} | {id, error}     no shell round-trip)
//   client → {sub, path}              subscribe to a same-origin SSE route
//   server → {sub, data}              raw SSE bytes for that subscription
//   server → {sub, end:true}          upstream closed
//   client → {unsub: sub}             cancel a subscription

const AUTH_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

function tokensMatch(a: string, b: string): boolean {
  // Hash both sides so the comparison is constant-time even when lengths differ.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

interface ExecMessage {
  token?: string;
  id?: number;
  command?: string;
  ui?: unknown;
  sub?: number;
  path?: string;
  unsub?: number;
}

/** In-process handler for `{id, ui}` requests; resolves to the reply body. */
export type UiRequestHandler = (payload: unknown) => Promise<Record<string, unknown>>;

interface ExecChannelOptions {
  path: string;
  execToken: string;
  /** Exact pathnames (query excluded) the channel may proxy as SSE. */
  ssePrefixes?: string[];
  /** In-process handler for `{id, ui}` simulator-settings requests. */
  onUiRequest?: UiRequestHandler;
}

function wireExecSocket(
  ws: WebSocket,
  serverPort: number | undefined,
  opts: ExecChannelOptions,
): void {
  let authed = false;
  const subscriptions = new Map<number, { destroy: () => void }>();
  const ssePrefixes = opts.ssePrefixes ?? [];

  const send = (value: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
  };

  const authTimer = setTimeout(() => {
    if (!authed) ws.close();
  }, AUTH_TIMEOUT_MS);
  authTimer.unref?.();

  const subscribe = (sub: number, path: string) => {
    if (subscriptions.has(sub)) return;
    // Only same-origin SSE routes owned by this middleware are reachable, and
    // only for authed sockets — strictly less exposure than the routes' own
    // direct (tokenless same-origin) GET surface.
    const pathOnly = path.split("?")[0]!;
    if (!path.startsWith("/") || !ssePrefixes.some((p) => pathOnly === p)) {
      send({ sub, end: true, error: "path not allowed" });
      return;
    }
    // Loop the request back through our own HTTP server; server-to-self
    // connections are not subject to the browser's per-origin pool.
    if (!serverPort) {
      send({ sub, end: true, error: "no local port" });
      return;
    }
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: serverPort,
        path,
        headers: { accept: "text/event-stream" },
      },
      (res) => {
        res.on("data", (chunk: Buffer) => send({ sub, data: chunk.toString("utf-8") }));
        res.on("end", () => {
          subscriptions.delete(sub);
          send({ sub, end: true });
        });
      },
    );
    upstream.on("error", () => {
      subscriptions.delete(sub);
      send({ sub, end: true });
    });
    upstream.end();
    subscriptions.set(sub, { destroy: () => upstream.destroy() });
  };

  ws.on("message", (data) => {
    let msg: ExecMessage;
    try {
      msg = JSON.parse(data.toString()) as ExecMessage;
    } catch {
      return;
    }
    if (!authed) {
      if (typeof msg.token === "string" && tokensMatch(msg.token, opts.execToken)) {
        authed = true;
        clearTimeout(authTimer);
        send({ ready: true });
      } else {
        ws.close();
      }
      return;
    }
    if (typeof msg.unsub === "number") {
      subscriptions.get(msg.unsub)?.destroy();
      subscriptions.delete(msg.unsub);
      return;
    }
    if (typeof msg.sub === "number" && typeof msg.path === "string") {
      subscribe(msg.sub, msg.path);
      return;
    }
    if (typeof msg.id === "number" && msg.ui !== undefined) {
      const { id } = msg;
      if (!opts.onUiRequest) {
        send({ id, error: "ui requests not supported" });
        return;
      }
      opts
        .onUiRequest(msg.ui)
        .then((reply) => send({ id, ...reply }))
        .catch((e: unknown) =>
          send({ id, error: e instanceof Error ? e.message : String(e) }),
        );
      return;
    }
    if (typeof msg.id !== "number" || typeof msg.command !== "string" || !msg.command) {
      return;
    }
    const { id, command } = msg;
    exec(command, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      send({
        id,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: err ? ((err as ExecException).code ?? 1) : 0,
      });
    });
  });

  ws.on("error", () => ws.close());
  ws.on("close", () => {
    clearTimeout(authTimer);
    for (const sub of subscriptions.values()) sub.destroy();
    subscriptions.clear();
  });
}

/**
 * Upgrade handler for `<basePath>/exec-ws`. Returns true when the request was
 * for the exec channel (and the socket has been taken over), false when the
 * caller should handle (or destroy) the socket itself.
 */
export function createExecUpgradeHandler(opts: ExecChannelOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  return function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const rawUrl = req.url ?? "";
    const qIndex = rawUrl.indexOf("?");
    const url = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    if (url !== opts.path && url !== `${opts.path}/`) return false;

    // Same-origin policy mirrors POST /exec: browsers always send Origin on
    // WebSocket upgrades, and a cross-origin page's Origin won't match Host.
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) {
          socket.destroy();
          return true;
        }
      } catch {
        socket.destroy();
        return true;
      }
    }

    // Port for SSE loopback requests: prefer the socket's own local port,
    // fall back to the Host header (Bun's upgrade socket may not expose it).
    let serverPort = (socket as Socket).localPort;
    if (!serverPort) {
      const hostPort = Number((req.headers.host ?? "").split(":")[1]);
      if (Number.isFinite(hostPort) && hostPort > 0) serverPort = hostPort;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wireExecSocket(ws, serverPort, opts);
    });
    return true;
  };
}
