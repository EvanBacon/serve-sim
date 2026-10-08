import { exec, type ExecException } from "child_process";
import { createHash, timingSafeEqual } from "crypto";
import { request as httpRequest, type IncomingMessage } from "http";
import type { Socket } from "net";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";
import { isLoopbackSameOrigin, isTrustedLoopback, originCheck } from "./request-trust";

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
//                                     (loopback page only; remote sockets are
//                                     authenticated at upgrade and cannot exec)
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
export type CommandResultHandler = (
  command: string,
  result: { stdout: string; stderr: string; exitCode: number },
) => void;

interface ExecChannelOptions {
  path: string;
  execToken: string;
  /** Exact pathnames (query excluded) the channel may proxy as SSE. */
  ssePrefixes?: string[];
  /** In-process handler for `{id, ui}` simulator-settings requests. */
  onUiRequest?: UiRequestHandler;
  /** Optional observer for completed shell commands. */
  onCommandResult?: CommandResultHandler;
  /**
   * Whether this upgrade may run shell commands. Defaults to a trusted
   * loopback peer whose Origin is the same loopback host (see
   * request-trust.ts). Sockets without shell access skip the exec-token
   * handshake (the upgrade was already authenticated) and get an error reply
   * for `{id, command}` frames.
   */
  allowShell?: (req: IncomingMessage) => boolean;
}

function defaultAllowShell(req: IncomingMessage): boolean {
  return isTrustedLoopback(req) && isLoopbackSameOrigin(req);
}

function wireExecSocket(
  ws: WebSocket,
  serverPort: number | undefined,
  opts: ExecChannelOptions,
  shellAllowed: boolean,
  upstreamHeaders: Record<string, string>,
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
    let upstream: ReturnType<typeof httpRequest>;
    try {
      upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: serverPort,
        path,
        headers: { accept: "text/event-stream", ...upstreamHeaders },
      },
      (res) => {
        res.on("data", (chunk: Buffer) => send({ sub, data: chunk.toString("utf-8") }));
        res.on("end", () => {
          subscriptions.delete(sub);
          send({ sub, end: true });
        });
      },
      );
    } catch {
      // e.g. a path with characters http.request rejects synchronously.
      send({ sub, end: true, error: "invalid path" });
      return;
    }
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
      // Shell-capable sockets prove they are the loopback preview page with
      // the exec token. Non-shell sockets were authenticated at upgrade.
      if (!shellAllowed || (typeof msg.token === "string" && tokensMatch(msg.token, opts.execToken))) {
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
    if (!shellAllowed) {
      send({ id, stdout: "", stderr: "exec is only available to loopback clients", exitCode: 126 });
      return;
    }
    exec(command, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const result = {
        id,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: err ? ((err as ExecException).code ?? 1) : 0,
      };
      try {
        opts.onCommandResult?.(command, result);
      } catch {
        // Command-result observers are diagnostic side-channels; a failure
        // here must not break the exec response path.
      }
      send(result);
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

    // Origin is required: the channel exists for the preview page, and
    // browsers always send Origin on WebSocket upgrades. A cross-origin page's
    // Origin won't match Host.
    if (originCheck(req) !== "same") {
      socket.destroy();
      return true;
    }
    const shellAllowed = (opts.allowShell ?? defaultAllowShell)(req);

    // Port for SSE loopback requests: prefer the socket's own local port.
    // Fall back to the Host header (Bun's upgrade socket may not expose it)
    // only when Host names a loopback address, so a caller can't aim the
    // loopback request at some other local service.
    let serverPort = (socket as Socket).localPort ?? (req.socket as Socket | undefined)?.localPort;
    if (!serverPort) {
      const host = req.headers.host ?? "";
      const hostPort = Number(host.split(":").pop());
      if (/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(host) && Number.isFinite(hostPort) && hostPort > 0) {
        serverPort = hostPort;
      }
    }

    // SSE subscriptions loop back through our own HTTP server. For a socket
    // that is not trusted loopback, carry its identity and credentials so the
    // looped-back request is gated (and redacted) exactly like a direct one.
    const upstreamHeaders: Record<string, string> = {};
    if (!shellAllowed) {
      upstreamHeaders["x-forwarded-for"] = req.socket?.remoteAddress ?? "remote";
      for (const name of ["authorization", "cookie"] as const) {
        const value = req.headers[name];
        if (typeof value === "string") upstreamHeaders[name] = value;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wireExecSocket(ws, serverPort, opts, shellAllowed, upstreamHeaders);
    });
    return true;
  };
}
