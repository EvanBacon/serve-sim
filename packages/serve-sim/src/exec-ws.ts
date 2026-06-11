import { exec, type ExecException } from "child_process";
import { createHash, timingSafeEqual } from "crypto";
import { request as httpRequest, type IncomingMessage } from "http";
import type { Socket } from "net";
import type { Duplex } from "stream";

// WebSocket control channel for the preview page. Browsers cap HTTP/1.1 at
// six connections per origin, and every preview tab used to hold several
// long-lived requests (MJPEG + 3-4 SSE channels + pooled exec fetches) — with
// two or more tabs open, new requests queue behind them forever. This channel
// carries shell execs *and* multiplexes the SSE side-channels, so each tab
// needs just one pooled connection (the video stream) plus this socket.
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

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const AUTH_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

function tokensMatch(a: string, b: string): boolean {
  // Hash both sides so the comparison is constant-time even when lengths differ.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function sendFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function sendJson(socket: Duplex, value: unknown): void {
  sendFrame(socket, 0x1, Buffer.from(JSON.stringify(value)));
}

function closeSocket(socket: Duplex): void {
  try {
    sendFrame(socket, 0x8, Buffer.alloc(0));
  } catch {}
  socket.end();
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

function wireExecSocket(
  socket: Duplex,
  execToken: string,
  ssePrefixes: string[],
  onUiRequest?: UiRequestHandler,
): void {
  let buffer = Buffer.alloc(0);
  let authed = false;
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  const subscriptions = new Map<number, { destroy: () => void }>();

  const authTimer = setTimeout(() => {
    if (!authed) closeSocket(socket);
  }, AUTH_TIMEOUT_MS);
  authTimer.unref?.();

  const subscribe = (sub: number, path: string) => {
    if (subscriptions.has(sub)) return;
    // Only same-origin SSE routes owned by this middleware are reachable, and
    // only for authed sockets — strictly less exposure than the routes' own
    // direct (tokenless same-origin) GET surface.
    const pathOnly = path.split("?")[0]!;
    if (!path.startsWith("/") || !ssePrefixes.some((p) => pathOnly === p)) {
      sendJson(socket, { sub, end: true, error: "path not allowed" });
      return;
    }
    // Loop the request back through our own HTTP server; server-to-self
    // connections are not subject to the browser's per-origin pool.
    const port = (socket as Socket).localPort;
    if (!port) {
      sendJson(socket, { sub, end: true, error: "no local port" });
      return;
    }
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { accept: "text/event-stream" },
      },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          if (!socket.destroyed) sendJson(socket, { sub, data: chunk.toString("utf-8") });
        });
        res.on("end", () => {
          subscriptions.delete(sub);
          if (!socket.destroyed) sendJson(socket, { sub, end: true });
        });
      },
    );
    upstream.on("error", () => {
      subscriptions.delete(sub);
      if (!socket.destroyed) sendJson(socket, { sub, end: true });
    });
    upstream.end();
    subscriptions.set(sub, { destroy: () => upstream.destroy() });
  };

  const handleMessage = (payload: Buffer) => {
    let msg: ExecMessage;
    try {
      msg = JSON.parse(payload.toString("utf-8")) as ExecMessage;
    } catch {
      return;
    }
    if (!authed) {
      if (typeof msg.token === "string" && tokensMatch(msg.token, execToken)) {
        authed = true;
        clearTimeout(authTimer);
        sendJson(socket, { ready: true });
      } else {
        closeSocket(socket);
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
      if (!onUiRequest) {
        sendJson(socket, { id, error: "ui requests not supported" });
        return;
      }
      onUiRequest(msg.ui)
        .then((reply) => {
          if (!socket.destroyed) sendJson(socket, { id, ...reply });
        })
        .catch((e: unknown) => {
          if (!socket.destroyed) {
            sendJson(socket, { id, error: e instanceof Error ? e.message : String(e) });
          }
        });
      return;
    }
    if (typeof msg.id !== "number" || typeof msg.command !== "string" || !msg.command) {
      return;
    }
    const { id, command } = msg;
    exec(command, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (socket.destroyed) return;
      sendJson(socket, {
        id,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: err ? ((err as ExecException).code ?? 1) : 0,
      });
    });
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = (buffer[0]! & 0x80) !== 0;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let payloadLength = buffer[1]! & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (buffer.length < 4) return;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) {
          closeSocket(socket);
          return;
        }
        payloadLength = Number(big);
        offset = 10;
      }
      if (payloadLength > MAX_FRAME_BYTES) {
        closeSocket(socket);
        return;
      }
      let maskKey: Buffer | null = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + payloadLength) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
      buffer = buffer.subarray(offset + payloadLength);
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i]! ^= maskKey[i % 4]!;
      }

      if (opcode === 0x8) {
        closeSocket(socket);
        return;
      }
      if (opcode === 0x9) {
        sendFrame(socket, 0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue; // unsolicited pong

      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) fragmentOpcode = opcode;
        fragments.push(payload);
        if (!fin) continue;
        const message = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments);
        fragments = [];
        if (fragmentOpcode === 0x1) handleMessage(message);
      }
    }
  });

  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
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
export function createExecUpgradeHandler(opts: {
  path: string;
  execToken: string;
  /** Exact pathnames (query excluded) the channel may proxy as SSE. */
  ssePrefixes?: string[];
  /** In-process handler for `{id, ui}` simulator-settings requests. */
  onUiRequest?: UiRequestHandler;
}) {
  return function handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): boolean {
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

    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.destroy();
      return true;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    (socket as Duplex & { setNoDelay?: (noDelay: boolean) => void }).setNoDelay?.(true);
    wireExecSocket(socket, opts.execToken, opts.ssePrefixes ?? [], opts.onUiRequest);
    return true;
  };
}
