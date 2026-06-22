/**
 * In-process device session — the replacement for the spawned serve-sim-bin
 * helper. One session per booted simulator owns a NativeCapture + NativeHid and
 * serves the same wire endpoints the helper's HTTP server did, byte-for-byte:
 *
 *   /stream.mjpeg  multipart/x-mixed-replace JPEG fan-out (?raw=1 → octet-stream)
 *   /stream.avcc   length-prefixed AVCC envelopes (seed + decoder config replay)
 *   /ws            binary HID input protocol ([tag][JSON]) → NativeHid
 *   /config        { width, height, orientation }
 *   /health        { status: "ok" }
 *   /ax            axe-shaped accessibility JSON (one-shot)
 *   /foreground    { bundleId, pid }
 *
 * Replaces the helper's HTTP/client layer; the framing here mirrors the
 * original byte-for-byte so the existing browser client is unchanged.
 */
import type { IncomingMessage, ServerResponse } from "http";
import { NativeCapture, NativeHid, Orientation, axDescribeAsync, axFrontmostAsync, type NativeFrame } from "./native";

/**
 * Minimal WebSocket surface the HID input channel needs. Satisfied by both the
 * `ws` library and the raw-socket adapter the middleware uses under Bun (where
 * `ws`'s server-side handshake doesn't flush). Messages arrive as binary
 * `[tag][JSON]` frames; `send` writes a binary frame.
 */
export interface HidSocket {
  send(data: Buffer): void;
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "close" | "error", cb: () => void): void;
  close(): void;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Don't let a stalled viewer's socket buffer grow without bound — drop frames
// for a client that's this far behind rather than balloon memory.
const MAX_CLIENT_BACKLOG = 8 * 1024 * 1024;

// AVCC seed tag (StreamFormat.AVCCEnvelope.seedTag). description/keyframe/delta
// envelopes are framed natively; only the on-connect JPEG seed is built here.
const AVCC_SEED_TAG = 0x04;

// WS server→client screen-config push (ClientManager.wsMsgConfig).
const WS_MSG_CONFIG = 0x82;

const MJPEG_TRAILER = Buffer.from("\r\n", "ascii");

function mjpegHeader(jpegLength: number): Buffer {
  return Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegLength}\r\n\r\n`, "ascii");
}

function avccSeed(jpeg: Buffer): Buffer {
  const out = Buffer.allocUnsafe(5 + jpeg.length);
  out.writeUInt32BE(jpeg.length + 1, 0); // length covers the tag byte + payload
  out[4] = AVCC_SEED_TAG;
  jpeg.copy(out, 5);
  return out;
}

const ORIENTATION_BY_NAME: Record<string, number> = {
  portrait: Orientation.portrait,
  portrait_upside_down: Orientation.portraitUpsideDown,
  landscape_left: Orientation.landscapeLeft,
  landscape_right: Orientation.landscapeRight,
};

export class DeviceSession {
  private readonly capture: NativeCapture;
  private readonly hid: NativeHid;
  private started = false;

  private width = 0;
  private height = 0;
  private orientation = "portrait";

  private latestJpeg: Buffer | null = null;
  private cachedAvccDescription: Buffer | null = null;
  private readonly mjpegClients = new Set<ServerResponse>();
  private readonly avccClients = new Set<ServerResponse>();
  private readonly hidSockets = new Set<HidSocket>();

  constructor(public readonly udid: string) {
    this.hid = new NativeHid(udid);
    this.capture = new NativeCapture(udid, (f) => this.onFrame(f));
  }

  /** Begin capture. Throws if the device isn't booted. Idempotent. */
  start(): void {
    if (this.started) return;
    this.capture.start();
    this.started = true;
  }

  close(): void {
    for (const res of this.mjpegClients) res.end();
    for (const res of this.avccClients) res.end();
    for (const ws of this.hidSockets) ws.close();
    this.mjpegClients.clear();
    this.avccClients.clear();
    this.hidSockets.clear();
    this.capture.stop();
  }

  // ── Frame fan-out ────────────────────────────────────────────────────────

  private onFrame(f: NativeFrame): void {
    if (f.codec === "mjpeg") {
      this.latestJpeg = f.data;
      if (f.width !== this.width || f.height !== this.height) {
        this.width = f.width;
        this.height = f.height;
        this.broadcastConfig();
      }
      if (this.mjpegClients.size === 0) return;
      // Build only the small header once; the JPEG itself is written by
      // reference to every client, avoiding a full-frame copy per frame.
      const header = mjpegHeader(f.data.length);
      for (const res of this.mjpegClients) this.writeMjpegFrame(res, header, f.data);
    } else {
      if (f.isDescription) this.cachedAvccDescription = f.data;
      for (const res of this.avccClients) this.writeAvccFrame(res, f.data);
    }
  }

  /** Write a multipart JPEG part (header + shared frame + boundary) without copying the JPEG. */
  private writeMjpegFrame(res: ServerResponse, header: Buffer, jpeg: Buffer): void {
    if (res.writableEnded || res.writableLength > MAX_CLIENT_BACKLOG) return;
    res.cork();
    res.write(header);
    res.write(jpeg);
    res.write(MJPEG_TRAILER);
    res.uncork();
  }

  /**
   * Write an AVCC chunk. AVCC is inter-frame H.264, so dropping a chunk corrupts
   * the decoder until the next IDR (visible tearing). Rather than drop, evict a
   * client whose socket is backed up: it reconnects via handleAvcc and is
   * re-seeded with the cached description + a fresh keyframe, yielding a clean
   * stream instead of a corrupted one.
   */
  private writeAvccFrame(res: ServerResponse, chunk: Buffer): void {
    if (res.writableEnded) {
      this.avccClients.delete(res);
      return;
    }
    if (res.writableLength > MAX_CLIENT_BACKLOG) {
      this.avccClients.delete(res);
      res.end();
      return;
    }
    res.write(chunk);
  }

  // ── HTTP handlers ────────────────────────────────────────────────────────

  handleMjpeg(req: IncomingMessage, res: ServerResponse): void {
    const raw = new URL(req.url ?? "", "http://x").searchParams.get("raw") === "1";
    res.writeHead(200, {
      "Content-Type": raw ? "application/octet-stream" : "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });
    this.mjpegClients.add(res);
    if (this.latestJpeg) this.writeMjpegFrame(res, mjpegHeader(this.latestJpeg.length), this.latestJpeg); // paint immediately
    const drop = () => this.mjpegClients.delete(res);
    res.on("close", drop);
    res.on("error", drop);
  }

  handleAvcc(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });
    this.avccClients.add(res);
    this.capture.setAvccActive(true);
    // Seed with the current screen, replay the cached decoder config, then force
    // an IDR so the freshly-configured decoder has a keyframe to start from.
    if (this.latestJpeg) res.write(avccSeed(this.latestJpeg));
    if (this.cachedAvccDescription) res.write(this.cachedAvccDescription);
    this.capture.requestKeyframe();
    const drop = () => {
      this.avccClients.delete(res);
      if (this.avccClients.size === 0) this.capture.setAvccActive(false);
    };
    res.on("close", drop);
    res.on("error", drop);
  }

  handleConfig(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, this.screenConfig());
  }

  handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, { status: "ok" });
  }

  handleAx(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.serveAxJson(res, () => axDescribeAsync(this.udid), "ax_unavailable");
  }

  handleForeground(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.serveAxJson(res, () => axFrontmostAsync(this.udid), "foreground_unavailable");
  }

  /** Run a native AX probe and stream its JSON, or 503 with `errorCode` if it's not ready. */
  private async serveAxJson(res: ServerResponse, probe: () => Promise<string>, errorCode: string): Promise<void> {
    try {
      const json = await probe();
      if (res.writableEnded) return;
      this.sendJsonString(res, 200, json);
    } catch (err) {
      if (res.writableEnded) return;
      this.sendJson(res, 503, {
        error: errorCode,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── HID WebSocket ────────────────────────────────────────────────────────

  attachHidSocket(ws: HidSocket): void {
    this.hidSockets.add(ws);
    const cfg = this.configFrame();
    if (cfg) ws.send(cfg); // seed dimensions/orientation, replacing the old poll
    ws.on("message", (data: Buffer) => this.handleHidMessage(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    ws.on("close", () => this.hidSockets.delete(ws));
    ws.on("error", () => this.hidSockets.delete(ws));
  }

  private handleHidMessage(data: Buffer): void {
    if (data.length < 1) return;
    const tag = data[0];
    const body = data.length > 1 ? data.subarray(1) : null;
    const json = <T>(): T | null => {
      if (!body) return null;
      try {
        return JSON.parse(body.toString("utf8")) as T;
      } catch {
        return null;
      }
    };
    const W = this.width;
    const H = this.height;

    switch (tag) {
      case 0x03: {
        const m = json<{ type: string; x: number; y: number; edge?: number }>();
        if (m) this.hid.touch(m.type as "begin" | "move" | "end", m.x, m.y, W, H, m.edge ?? 0);
        break;
      }
      case 0x04: {
        const m = json<{ button: string; page?: number; usage?: number; phase?: string }>();
        if (!m) break;
        if (m.page != null && m.usage != null) {
          this.hid.buttonHid(m.page, m.usage, (m.phase as "down" | "up" | "press") ?? "press");
        } else {
          this.hid.button(m.button);
        }
        break;
      }
      case 0x05: {
        const m = json<{ type: string; x1: number; y1: number; x2: number; y2: number }>();
        if (m) this.hid.multiTouch(m.type as "begin" | "move" | "end", m.x1, m.y1, m.x2, m.y2, W, H);
        break;
      }
      case 0x06: {
        const m = json<{ type: string; usage: number }>();
        if (m) this.hid.key(m.type as "down" | "up", m.usage);
        break;
      }
      case 0x07: {
        const m = json<{ orientation: string }>();
        if (!m) break;
        const value = ORIENTATION_BY_NAME[m.orientation];
        if (value != null && this.hid.orientation(value)) {
          if (m.orientation !== this.orientation) {
            this.orientation = m.orientation;
            this.broadcastConfig();
          }
        }
        break;
      }
      case 0x08: {
        const m = json<{ option: string; enabled: boolean }>();
        if (m) this.hid.caDebug(m.option, m.enabled);
        break;
      }
      case 0x09:
        this.hid.memoryWarning();
        break;
      case 0x0a: {
        const m = json<{ delta: number }>();
        if (m) this.hid.digitalCrown(m.delta);
        break;
      }
      case 0x0b: {
        // Payload deltas are a fraction of the display; scale to device pixels.
        const m = json<{ dx: number; dy: number; x?: number; y?: number }>();
        if (m) this.hid.scroll(m.dx * W, m.dy * H, W, H, m.x, m.y);
        break;
      }
      case 0x0c:
        this.hid.softwareKeyboard();
        break;
    }
  }

  // ── Config ───────────────────────────────────────────────────────────────

  screenConfig(): { width: number; height: number; orientation: string } {
    return { width: this.width, height: this.height, orientation: this.orientation };
  }

  private configFrame(): Buffer | null {
    if (this.width === 0 && this.height === 0) return null;
    return Buffer.concat([Buffer.from([WS_MSG_CONFIG]), Buffer.from(JSON.stringify(this.screenConfig()))]);
  }

  private broadcastConfig(): void {
    const frame = this.configFrame();
    if (!frame) return;
    for (const ws of this.hidSockets) ws.send(frame);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    this.sendJsonString(res, status, JSON.stringify(body));
  }

  private sendJsonString(res: ServerResponse, status: number, json: string): void {
    const buf = Buffer.from(json, "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store",
      "Content-Length": String(buf.length),
      ...CORS,
    });
    res.end(buf);
  }
}

// ── Registry ─────────────────────────────────────────────────────────────

const sessions = new Map<string, DeviceSession>();

/**
 * Get (lazily creating + starting) the in-process session for `udid`. Throws if
 * the device isn't booted. The session lives until `closeDeviceSession`.
 */
export function getDeviceSession(udid: string): DeviceSession {
  let session = sessions.get(udid);
  if (!session) {
    session = new DeviceSession(udid);
    try {
      session.start();
    } catch (err) {
      session.close();
      throw err;
    }
    sessions.set(udid, session);
  }
  return session;
}

export function closeDeviceSession(udid: string): void {
  const session = sessions.get(udid);
  if (session) {
    session.close();
    sessions.delete(udid);
  }
}
