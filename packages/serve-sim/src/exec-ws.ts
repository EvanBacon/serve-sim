import { exec, type ExecException } from "child_process";
import { timingSafeEqual } from "crypto";
import { request as httpRequest, type IncomingMessage } from "http";
import type { Socket } from "net";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";
import { isLoopbackSameOrigin, isTrustedLoopback, originCheck } from "./request-trust";

// WebSocket control channel for the preview page. Browsers cap HTTP/1.1 at
// six connections per origin, and every preview tab used to hold several
// long-lived requests (MJPEG + 3-4 SSE channels + pooled exec fetches) — with
// two or more tabs open, new requests queue behind them forever. This channel
// carries host RPCs, simulator-settings requests, multiplexed SSE
// subscriptions, and (opt-in, token-gated) shell execs, so each tab needs just one pooled connection (the video
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
//   client → {} | {token}             first frame (the upgrade itself was
//                                     authenticated; the page holds no token —
//                                     only a local process that read the
//                                     owner-only exec token file sends one)
//   server → {ready:true}             channel ready
//   client → {id, command}            run a shell command (only with
//                                     allowExec, a loopback same-origin
//                                     socket, AND the exec token)
//   server → {id, stdout, stderr, exitCode}
//   client → {id, rpc:{method,params}} narrow host action (host-rpc.ts:
//   server → {id, …} | {id, error}     validated params, argv, no shell)
//   client → {id, ui:{…}}             simulator-settings request (in-process,
//   server → {id, …} | {id, error}     no shell round-trip)
//   client → {sub, path}              subscribe to a same-origin SSE route
//   server → {sub, data}              raw SSE bytes for that subscription
//   server → {sub, end:true}          upstream closed
//   client → {unsub: sub}             cancel a subscription

const AUTH_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export const EXEC_DISABLED_MESSAGE = "exec disabled; start with --allow-exec";
export const EXEC_TOKEN_REQUIRED_MESSAGE = "exec requires the exec token";
export const RPC_LOOPBACK_ONLY_MESSAGE = "host actions are only available to loopback clients";

interface ExecMessage {
  id?: number;
  token?: unknown;
  command?: string;
  rpc?: unknown;
  ui?: unknown;
  sub?: number;
  path?: string;
  unsub?: number;
}

/** C0 controls, DEL, or any whitespace: never valid in a subscribe path. */
function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return /\s/.test(value);
}

/** In-process handler for `{id, ui}` requests; resolves to the reply body. */
export type UiRequestHandler = (payload: unknown) => Promise<Record<string, unknown>>;
/** In-process handler for `{id, rpc}` host actions; resolves to the reply body. */
export type RpcRequestHandler = (payload: unknown) => Promise<Record<string, unknown>>;
export type CommandResultHandler = (
  command: string,
  result: { stdout: string; stderr: string; exitCode: number },
) => void;

interface ExecChannelOptions {
  path: string;
  /** Run `{id, command}` frames at all (`--allow-exec`). Default false. */
  allowExec?: boolean;
  /**
   * Per-process exec token. A socket may run `{id, command}` only after its
   * first frame presented it (`{token}`). Without one, commands never run.
   */
  execToken?: string;
  /** Exact pathnames (query excluded) the channel may proxy as SSE. */
  ssePrefixes?: string[];
  /** In-process handler for `{id, ui}` simulator-settings requests. */
  onUiRequest?: UiRequestHandler;
  /** In-process handler for `{id, rpc}` host actions (see host-rpc.ts). */
  onRpcRequest?: RpcRequestHandler;
  /** Optional observer for completed shell commands. */
  onCommandResult?: CommandResultHandler;
  /**
   * Whether this upgrade may run shell commands (when `allowExec` is set).
   * Defaults to a trusted loopback peer whose Origin is the same loopback
   * host (see request-trust.ts). Other sockets get an error reply for
   * `{id, command}` frames.
   */
  allowShell?: (req: IncomingMessage) => boolean;
  /**
   * Whether this upgrade may send `{id, rpc}` host actions. Same default as
   * `allowShell` (trusted loopback, loopback same-origin), but independent of
   * the exec token. `allowExec` still gates `installApp` inside host-rpc.ts.
   */
  allowRpc?: (req: IncomingMessage) => boolean;
}

function tokenMatches(presented: unknown, expected: string | undefined): boolean {
  if (!expected || typeof presented !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultAllowShell(req: IncomingMessage): boolean {
  return isTrustedLoopback(req) && isLoopbackSameOrigin(req);
}

function wireExecSocket(
  ws: WebSocket,
  serverPort: number | undefined,
  opts: ExecChannelOptions,
  shellAllowed: boolean,
  rpcAllowed: boolean,
): void {
  let authed = false;
  // Set only when the first frame carried the exec token.
  let execTokenOk = false;
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
    // Reject control chars / spaces before http.request (ERR_UNESCAPED_CHARACTERS).
    if (
      !path.startsWith("/") ||
      hasControlOrSpace(path) ||
      !ssePrefixes.some((p) => pathOnly === p)
    ) {
      send({ sub, end: true, error: "path not allowed" });
      return;
    }
    // Loop the request back through our own HTTP server; server-to-self
    // connections are not subject to the browser's per-origin pool.
    if (!serverPort) {
      send({ sub, end: true, error: "no local port" });
      return;
    }
    let upstream;
    try {
      upstream = httpRequest(
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
    } catch {
      send({ sub, end: true, error: "bad path" });
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
      // The upgrade was already authenticated; the first frame opens the
      // channel. The page never holds the exec token, so its `{}` opens a
      // channel that can never run shell commands.
      authed = true;
      execTokenOk = tokenMatches(msg.token, opts.execToken);
      clearTimeout(authTimer);
      send({ ready: true });
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
    if (typeof msg.id === "number" && msg.rpc !== undefined) {
      const { id } = msg;
      if (!opts.onRpcRequest) {
        send({ id, error: "rpc requests not supported" });
        return;
      }
      if (!rpcAllowed) {
        send({ id, error: RPC_LOOPBACK_ONLY_MESSAGE });
        return;
      }
      opts
        .onRpcRequest(msg.rpc)
        .then((reply) => send({ ...reply, id }))
        .catch((e: unknown) =>
          send({ id, error: e instanceof Error ? e.message : String(e) }),
        );
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
    if (!opts.allowExec) {
      send({ id, stdout: "", stderr: EXEC_DISABLED_MESSAGE, exitCode: 126, error: EXEC_DISABLED_MESSAGE });
      return;
    }
    if (!shellAllowed) {
      send({ id, stdout: "", stderr: "exec is only available to loopback clients", exitCode: 126 });
      return;
    }
    if (!execTokenOk) {
      send({ id, stdout: "", stderr: EXEC_TOKEN_REQUIRED_MESSAGE, exitCode: 126, error: EXEC_TOKEN_REQUIRED_MESSAGE });
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
    const rpcAllowed = (opts.allowRpc ?? defaultAllowShell)(req);

    // Port for SSE loopback requests: prefer the socket's own local port,
    // fall back to the Host header (Bun's upgrade socket may not expose it).
    let serverPort = (socket as Socket).localPort;
    if (!serverPort) {
      const hostPort = Number((req.headers.host ?? "").split(":")[1]);
      if (Number.isFinite(hostPort) && hostPort > 0) serverPort = hostPort;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wireExecSocket(ws, serverPort, opts, shellAllowed, rpcAllowed);
    });
    return true;
  };
}
