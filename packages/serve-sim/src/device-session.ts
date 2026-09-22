import { warnDeviceHubInput } from "./device-hub-input";
import { DuoRenderer, type DuoProjection } from "./duo-renderer";
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
import { DuoStateMonitor, type DuoState } from "./duo-state";
import type { IncomingMessage, ServerResponse } from "http";
import { displaySizeForHingeDegrees, resolveDevicePose } from "./device-pose";
import {
  NativeCapture,
  NativeHid,
  Orientation,
  axDescribeAsync,
  axFrontmostAsync,
  type MjpegFrame,
} from "./native";
import { eventLogEventForHidMessage, formatEventLogPoint, recordEventLogEvent, updateEventLogEvent } from "./event-log";

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

// AVCC seed tag (StreamFormat.AVCCEnvelope.seedTag). description/keyframe/delta
// envelopes are framed natively; only the on-connect JPEG seed is built here.
const AVCC_SEED_TAG = 0x04;

// WS server→client screen-config push (ClientManager.wsMsgConfig).
const WS_MSG_CONFIG = 0x82;

const MJPEG_TRAILER = Buffer.from("\r\n", "ascii");
// Native capture is event-driven, so an unchanged screen can legitimately
// produce no new JPEGs. Replay the already-encoded frame below the client's
// 2s liveness window instead of re-encoding identical pixels in Swift.
const MJPEG_IDLE_REPLAY_MS = 1_000;
const TOUCH_TAP_MAX_DISTANCE = 0.004;
// Matches the cubic ease-out sweep in HIDInjector.setPose.
const DUO_FOLD_DURATION_MS = 800;

type TouchGestureLog = {
  eventId?: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moveCount: number;
  edge?: number;
};

function touchGestureSummary(gesture: TouchGestureLog): string {
  return `Drag ${formatEventLogPoint(gesture.startX, gesture.startY)} -> ${formatEventLogPoint(gesture.lastX, gesture.lastY)}`;
}

function touchGestureMoved(gesture: TouchGestureLog): boolean {
  const dx = gesture.lastX - gesture.startX;
  const dy = gesture.lastY - gesture.startY;
  return Math.hypot(dx, dy) > TOUCH_TAP_MAX_DISTANCE;
}

function newTouchGesture(payload: { x: number; y: number; edge?: number }): TouchGestureLog {
  return {
    startX: payload.x,
    startY: payload.y,
    lastX: payload.x,
    lastY: payload.y,
    moveCount: 0,
    edge: payload.edge,
  };
}

function mjpegHeader(jpegLength: number): Buffer {
  return Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegLength}\r\n\r\n`, "ascii");
}

function duoFrameHeader(frameLength: number): Buffer {
  return Buffer.from(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${frameLength}\r\n\r\n`, "ascii");
}

function avccSeed(jpeg: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + jpeg.length);
  out.writeUInt32BE(jpeg.length + 1, 0); // length covers the tag byte + payload
  out[4] = AVCC_SEED_TAG;
  out.set(jpeg, 5);
  return out;
}

const ORIENTATION_BY_NAME: Record<string, number> = {
  portrait: Orientation.portrait,
  portrait_upside_down: Orientation.portraitUpsideDown,
  landscape_left: Orientation.landscapeLeft,
  landscape_right: Orientation.landscapeRight,
};

function waitForDrain(res: ServerResponse): Promise<void> {
  if (res.writableEnded || res.destroyed || !res.writableNeedDrain) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

async function writeAndDrain(
  res: ServerResponse,
  write: () => boolean,
): Promise<boolean> {
  await waitForDrain(res);
  if (res.writableEnded || res.destroyed) return false;

  const accepted = write();
  if (!accepted || res.writableNeedDrain) await waitForDrain(res);
  return !res.writableEnded && !res.destroyed;
}

type CaptureTransport = Pick<
  NativeCapture,
  "start" | "stop" | "subscribeMjpeg" | "subscribeAvcc" | "setPreferredScreenSize"
>;
type HidTransport = Pick<
  NativeHid,
  | "touch"
  | "multiTouch"
  | "button"
  | "buttonHid"
  | "key"
  | "scroll"
  | "digitalCrown"
  | "orientation"
  | "memoryWarning"
  | "softwareKeyboard"
  | "caDebug"
  | "pose"
  | "hinge"
> & Partial<Pick<NativeHid, "close" | "isFoldable">>;

export interface DeviceSessionDependencies {
  capture: CaptureTransport;
  hid: HidTransport;
  createDuoRenderer?: () => Pick<DuoRenderer, "render" | "close">;
  createDuoMonitor?: (udid: string, onState: (state: DuoState) => void) => Pick<DuoStateMonitor, "close" | "refreshOrientation">;
}

type Unsubscribe = () => void | Promise<void>;

export class DeviceSession {
  private readonly capture: CaptureTransport;
  private readonly hid: HidTransport;
  private unsubscribeMjpeg?: Unsubscribe;
  private phase: "unstarted" | "starting" | "running" | "failed" | "stopped" = "unstarted";
  private startPromise?: Promise<void>;

  private width = 0;
  private height = 0;
  private orientation = "portrait";
  private duoViewOrientation = "portrait";
  private duoViewRoll = 0;
  private duoRotationTimer?: ReturnType<typeof setTimeout>;
  private duoFoldTimer?: ReturnType<typeof setTimeout>;
  private duoFold?: { from: number; target: number; began?: number };

  private latestJpegBuffer: Buffer | null = null;
  private latestJpegLength = 0;
  private readonly hidSockets = new Set<HidSocket>();
  private duoRenderer?: Pick<DuoRenderer, "render" | "close">;
  private duoProjection?: DuoProjection;
  private duoRenderBusy = false;
  private duoRenderPending = false;
  private duoSettleTimer?: ReturnType<typeof setTimeout>;
  private readonly duoResponses = new Set<ServerResponse>();
  private duoMonitor?: Pick<DuoStateMonitor, "close" | "refreshOrientation">;
  private hingeDegrees?: number;
  private followedPanel?: boolean;
  private primaryDuoPanel?: "cover" | "inner";
  private poseQueue: Promise<void> = Promise.resolve();
  private duoStateQueue: Promise<void> = Promise.resolve();
  private readonly streamResponses = new Set<ServerResponse>();
  private touchGestureLog?: TouchGestureLog;

  constructor(public readonly udid: string, private readonly dependencies?: DeviceSessionDependencies) {
    this.hid = dependencies?.hid ?? new NativeHid(udid);
    this.capture = dependencies?.capture ?? new NativeCapture(udid);
  }

  /** Begin capture and retain one shared MJPEG subscription. Idempotent. */
  start(): Promise<void> {
    if (this.phase === "stopped") {
      return Promise.reject(new Error(`Device session ${this.udid} is closed`));
    }
    if (this.startPromise) return this.startPromise;

    this.phase = "starting";
    const startPromise = (async () => {
      await this.capture.start();
      if (this.isStopped()) throw new Error(`Device session ${this.udid} closed while starting`);

      const unsubscribe = await this.capture.subscribeMjpeg((frame) => this.onSharedMjpegFrame(frame));
      if (this.isStopped()) {
        await unsubscribe();
        throw new Error(`Device session ${this.udid} closed while starting`);
      }
      this.unsubscribeMjpeg = unsubscribe;
      this.phase = "running";
      if (await this.hid.isFoldable?.() && !this.isStopped()) {
        if (!this.dependencies?.createDuoMonitor) void warnDeviceHubInput(this.udid);
        const createMonitor = this.dependencies?.createDuoMonitor ?? ((udid, onState) => new DuoStateMonitor(udid, onState));
        this.duoMonitor = createMonitor(this.udid, (state) => {
          void this.followDuoState(state).catch((error) => {
            console.error("[duo] State update failed:", error);
          });
        });
      }
    })().catch((error) => {
      // Failed DeviceSession instances are evicted by the registry below. Keep
      // this promise latched so concurrent endpoints all observe the same
      // failure instead of racing a second start on an instance being closed.
      if (this.phase === "starting") this.phase = "failed";
      throw error;
    });

    // A session is started eagerly by the registry, before an HTTP stream has
    // necessarily awaited it. Attach a rejection observer immediately so a
    // shutdown race can never become a process-fatal unhandled rejection.
    void startPromise.catch(() => {});
    this.startPromise = startPromise;
    return startPromise;
  }

  private isStopped(): boolean {
    return this.phase === "stopped";
  }

  close(): void {
    if (this.phase === "stopped") return;
    this.phase = "stopped";
    clearTimeout(this.duoSettleTimer);
    clearTimeout(this.duoRotationTimer);
    clearTimeout(this.duoFoldTimer);
    this.duoFold = undefined;
    this.duoMonitor?.close();
    this.duoRenderer?.close();
    this.duoResponses.clear();
    for (const ws of this.hidSockets) {
      this.runCleanup("HID socket close", () => ws.close());
    }
    for (const res of this.streamResponses) {
      this.runCleanup("stream response close", () => { res.destroy(); });
    }
    this.streamResponses.clear();
    if (this.unsubscribeMjpeg) {
      this.runCleanup("shared MJPEG unsubscribe", this.unsubscribeMjpeg);
    }
    this.hidSockets.clear();
    this.runCleanup("HID close", () => this.hid.close?.());
    this.runCleanup("capture stop", () => this.capture.stop());
  }

  private followDuoState(state: DuoState): Promise<void> {
    const update = this.duoStateQueue.then(() => this.applyDuoState(state));
    this.duoStateQueue = update.catch(() => {});
    return update;
  }

  private async applyDuoState(state: DuoState): Promise<void> {
    if (this.isStopped()) return;
    if (state.hingeDegrees != null) {
      this.hingeDegrees = state.hingeDegrees;
      const fold = this.duoFold;
      if (fold && fold.began == null && fold.from !== fold.target) {
        const fraction = (state.hingeDegrees - fold.from) / (fold.target - fold.from);
        if (fraction > 0 && fraction <= 1) {
          // Invert the guest's 800 ms cubic ease-out sweep. Starting on its
          // first sample avoids animating before the HID bridge is ready.
          fold.began = performance.now() - DUO_FOLD_DURATION_MS * (1 - Math.cbrt(1 - fraction));
          this.tickDuoFold();
        }
      }
    }
    if (state.primaryPanel) this.primaryDuoPanel = state.primaryPanel;
    const size = displaySizeForHingeDegrees(this.primaryDuoPanel ? (this.primaryDuoPanel === "cover" ? 0 : 180) : this.hingeDegrees ?? 0);
    if ((state.hingeDegrees != null || state.primaryPanel) && size.coverActive !== this.followedPanel) {
      await this.capture.setPreferredScreenSize(size.width, size.height);
      this.followedPanel = size.coverActive;
    }
    const orientation = state.orientations[size.coverActive ? "cover" : "inner"];
    if (orientation) this.orientation = orientation;
    this.broadcastConfig();
    this.renderDuoFrame();
  }

  // ── Frame handling ───────────────────────────────────────────────────────

  private async onSharedMjpegFrame(frame: MjpegFrame): Promise<void> {
    const { width, height, data: jpeg } = frame;

    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.broadcastConfig();
    }

    if (!this.latestJpegBuffer || this.latestJpegBuffer.length < jpeg.length) {
      const currentCapacity = this.latestJpegBuffer?.length ?? 0;
      this.latestJpegBuffer = Buffer.allocUnsafe(Math.max(jpeg.length, currentCapacity * 2));
    }
    this.latestJpegBuffer.set(jpeg, 0);
    this.latestJpegLength = jpeg.length;
    this.renderDuoFrame();
  }

  private renderDuoFrame(fullResolution = false): void {
    const renderer = this.duoRenderer;
    const jpeg = this.latestJpeg();
    if (!this.duoResponses.size || !renderer || !jpeg || this.hingeDegrees == null || this.isStopped()) return;
    if (!fullResolution) {
      clearTimeout(this.duoSettleTimer);
      this.duoSettleTimer = setTimeout(() => this.renderDuoFrame(true), 180);
      this.duoSettleTimer.unref?.();
    }
    if (this.duoRenderBusy) { this.duoRenderPending = true; return; }
    this.duoRenderBusy = true;
    this.duoRenderPending = false;
    const panel = this.width === 1398 || this.height === 1398 ? "cover" : "inner";
    // Guest orientation and active display can change during folding. Keep the
    // physical model stable; only an explicit Rotate command changes its roll.
    const roll = this.duoViewRoll;
    void renderer.render(jpeg, panel, this.duoFoldAngle(), roll, fullResolution).then(({ jpeg: rendered, projection }) => {
      if (this.isStopped() || this.duoRenderer !== renderer) return;
      if (JSON.stringify(this.duoProjection) !== JSON.stringify(projection)) {
        this.duoProjection = projection;
        const config = Buffer.concat([Buffer.from([0x83]), Buffer.from(JSON.stringify(projection))]);
        for (const ws of this.hidSockets) ws.send(config);
      }
      for (const response of this.duoResponses) {
        if (!response.destroyed && !response.writableEnded && response.writableLength === 0) this.writeDuoFrame(response, rendered);
      }
    }).catch((error) => {
      if (this.duoRenderer !== renderer) return;
      for (const response of this.duoResponses) this.handleStreamError(response, error);
      renderer.close();
      this.duoRenderer = undefined;
    }).finally(() => {
      if (this.duoRenderer !== renderer) return;
      this.duoRenderBusy = false;
      if (this.duoRenderPending) this.renderDuoFrame();
    });
  }

  private duoFoldAngle(): number {
    const fold = this.duoFold;
    if (!fold || fold.began == null) return this.hingeDegrees ?? 0;
    const progress = Math.min(1, Math.max(0, (performance.now() - fold.began) / DUO_FOLD_DURATION_MS));
    return fold.from + (fold.target - fold.from) * (1 - (1 - progress) ** 3);
  }

  private tickDuoFold(): void {
    clearTimeout(this.duoFoldTimer);
    if (this.isStopped() || this.duoFold?.began == null) return;
    this.renderDuoFrame();
    if (performance.now() < this.duoFold.began + DUO_FOLD_DURATION_MS) {
      this.duoFoldTimer = setTimeout(() => this.tickDuoFold(), 16);
      this.duoFoldTimer.unref?.();
    }
  }

  private animateDuoRotation(orientation: string): void {
    clearTimeout(this.duoRotationTimer);
    const target = { portrait: 0, landscape_left: -90, portrait_upside_down: -180, landscape_right: 90 }[orientation] ?? 0;
    const start = this.duoViewRoll;
    const delta = ((target - start + 540) % 360) - 180;
    const began = performance.now();
    const tick = () => {
      if (this.isStopped()) return;
      const progress = Math.min(1, (performance.now() - began) / 300);
      const eased = progress * progress * (3 - 2 * progress);
      this.duoViewRoll = progress === 1 ? target : start + delta * eased;
      this.renderDuoFrame();
      if (progress < 1) this.duoRotationTimer = setTimeout(tick, 16);
    };
    tick();
  }

  private latestJpeg(): Buffer | null {
    if (!this.latestJpegBuffer) return null;
    return this.latestJpegBuffer.subarray(0, this.latestJpegLength);
  }

  /** Write a multipart JPEG part (header + shared frame + boundary) without copying the JPEG. */
  private writeMjpegFrame(res: ServerResponse, jpeg: Uint8Array): boolean {
    const headerAccepted = res.write(mjpegHeader(jpeg.length));
    const frameAccepted = res.write(jpeg);
    const trailerAccepted = res.write(MJPEG_TRAILER);
    return headerAccepted && frameAccepted && trailerAccepted;
  }

  /** Duo 3D frames are PNG with alpha so the page shows through (no black matte). */
  private writeDuoFrame(res: ServerResponse, frame: Uint8Array): boolean {
    const headerAccepted = res.write(duoFrameHeader(frame.length));
    const frameAccepted = res.write(frame);
    const trailerAccepted = res.write(MJPEG_TRAILER);
    return headerAccepted && frameAccepted && trailerAccepted;
  }

  // ── HTTP handlers ────────────────────────────────────────────────────────

  handleDuoMjpeg(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      await this.start();
      if (res.destroyed || res.writableEnded) return;
      if (!await this.hid.isFoldable?.()) { this.sendJson(res, 400, { error: "This device has no Duo model" }); return; }
      if (!this.duoRenderer) {
        this.duoRenderer = this.dependencies?.createDuoRenderer?.() ?? new DuoRenderer();
        this.duoRenderBusy = false;
      }
      const raw = new URL(req.url ?? "", "http://x").searchParams.get("raw") === "1";
      res.writeHead(200, { "Content-Type": raw ? "application/octet-stream" : "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store", ...CORS });
      this.trackStreamResponse(res);
      this.duoResponses.add(res);
      this.renderDuoFrame();
      res.once("close", () => {
        this.duoResponses.delete(res);
        if (!this.duoResponses.size) { clearTimeout(this.duoSettleTimer); this.duoRenderer?.close(); this.duoRenderer = undefined; }
      });
    })().catch((error) => this.handleStreamError(res, error));
  }

  handleMjpeg(req: IncomingMessage, res: ServerResponse): void {
    void this.serveMjpeg(req, res).catch((error) => this.handleStreamError(res, error));
  }

  private async serveMjpeg(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.start();
    if (res.writableEnded || res.destroyed) return;

    const raw = new URL(req.url ?? "", "http://x").searchParams.get("raw") === "1";
    res.writeHead(200, {
      "Content-Type": raw ? "application/octet-stream" : "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });
    if (!this.trackStreamResponse(res)) return;

    // The native subscriber reuses its frame buffer after this callback
    // resolves. Keep the callback pending through HTTP backpressure so the
    // bytes cannot be mutated before res.write consumes them. CaptureEngine's
    // bufferingNewest(1) policy drops stale frames on the native side while a
    // slow client drains, so this neither interleaves parts nor grows a queue.
    let writeInFlight = false;
    let lastSentAt = 0;
    const writeFrame = async (jpeg: Uint8Array): Promise<void> => {
      // This can only overlap when the idle replay timer wins the event-loop
      // turn immediately before a native frame. Prefer the in-flight write and
      // let the next native frame provide the freshest image.
      if (writeInFlight || res.writableEnded || res.destroyed) return;
      writeInFlight = true;
      try {
        if (await writeAndDrain(res, () => this.writeMjpegFrame(res, jpeg))) {
          lastSentAt = Date.now();
        }
      } catch (error) {
        if (!res.destroyed) {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        writeInFlight = false;
      }
    };

    const latestJpeg = this.latestJpeg();
    // The shared cache is reused in place. Copy this one on-connect seed before
    // awaiting backpressure; native subscriber frames below remain zero-copy.
    if (latestJpeg) await writeFrame(Buffer.from(latestJpeg));
    const unsubscribe = await this.capture.subscribeMjpeg(async (frame) => {
      await writeFrame(frame.data);
    });
    const idleReplay = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      if (Date.now() - lastSentAt < MJPEG_IDLE_REPLAY_MS) return;
      const cached = this.latestJpeg();
      // The shared cache is reused in place as fresh frames arrive. Copy only
      // this low-frequency replay so it stays immutable across backpressure.
      if (cached) void writeFrame(Buffer.from(cached));
    }, MJPEG_IDLE_REPLAY_MS);
    this.bindSubscription(res, async () => {
      clearInterval(idleReplay);
      await unsubscribe();
    });
  }

  handleAvcc(_req: IncomingMessage, res: ServerResponse): void {
    void this.serveAvcc(res).catch((error) => this.handleStreamError(res, error));
  }

  private async serveAvcc(res: ServerResponse): Promise<void> {
    await this.start();
    if (res.writableEnded || res.destroyed) return;

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });
    if (!this.trackStreamResponse(res)) return;

    // Seed with the current screen; the per-client native AVCC subscription
    // starts with its own decoder config and keyframe.
    const latestJpeg = this.latestJpeg();
    if (latestJpeg) res.write(avccSeed(latestJpeg));

    const unsubscribe = await this.capture.subscribeAvcc(async (frame) => {
      await writeAndDrain(res, () => res.write(frame.data));
    });
    this.bindSubscription(res, unsubscribe);
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
    if (this.duoProjection) ws.send(Buffer.concat([Buffer.from([0x83]), Buffer.from(JSON.stringify(this.duoProjection))]));
    if (cfg) ws.send(cfg); // seed dimensions/orientation, replacing the old poll
    ws.on("message", (data: Buffer) => {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (frame[0] === 0x0e) {
        this.poseQueue = this.poseQueue.then(async () => {
          if (this.isStopped()) return;
          let ok = false;
          try { ok = await this.handleHidMessage(frame) === true; }
          catch (error) { console.error("[hid] Pose failed:", error); }
          if (this.hidSockets.has(ws)) {
            ws.send(Buffer.concat([Buffer.from([0x0e]), Buffer.from(JSON.stringify({ ok }))]));
          }
        }).catch((error) => { console.error("[hid] Pose reply failed:", error); });
      } else {
        void this.handleHidMessage(frame).catch((error) => { console.error("[hid] Input failed:", error); });
      }
    });
    ws.on("close", () => this.hidSockets.delete(ws));
    ws.on("error", () => this.hidSockets.delete(ws));
  }

  private async handleHidMessage(data: Buffer): Promise<boolean | void> {
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
        if (m) {
          this.recordTouchEvent(m);
          this.hid.touch(m.type as "begin" | "move" | "end", m.x, m.y, W, H, m.edge ?? 0);
        }
        break;
      }
      case 0x04: {
        const m = json<{ button: string; page?: number; usage?: number; phase?: string }>();
        if (!m) break;
        this.recordHidEvent(tag, m);
        if (m.page != null && m.usage != null) {
          this.hid.buttonHid(m.page, m.usage, (m.phase as "down" | "up" | "press") ?? "press");
        } else {
          this.hid.button(m.button);
        }
        break;
      }
      case 0x05: {
        const m = json<{ type: string; x1: number; y1: number; x2: number; y2: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.multiTouch(m.type as "begin" | "move" | "end", m.x1, m.y1, m.x2, m.y2, W, H);
        }
        break;
      }
      case 0x06: {
        const m = json<{ type: string; usage: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.key(m.type as "down" | "up", m.usage);
        }
        break;
      }
      case 0x07: {
        const m = json<{ orientation: string }>();
        if (!m) break;
        const value = ORIENTATION_BY_NAME[m.orientation];
        if (value != null && await this.hid.orientation(value)) {
          this.recordHidEvent(tag, m);
          if (m.orientation !== this.orientation || m.orientation !== this.duoViewOrientation) {
            // Duo physical orientation and the active panel's UI orientation
            // differ (the inner panel's natural axis is rotated). Let the
            // monitor report the guest UI; never overwrite it with view state.
            if (this.hingeDegrees == null) this.orientation = m.orientation;
            this.duoViewOrientation = m.orientation;
            this.animateDuoRotation(m.orientation);
            this.duoMonitor?.refreshOrientation();
            this.broadcastConfig();
            this.renderDuoFrame();
          }
        }
        break;
      }
      case 0x08: {
        const m = json<{ option: string; enabled: boolean }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.caDebug(m.option, m.enabled);
        }
        break;
      }
      case 0x09:
        this.recordHidEvent(tag, {});
        this.hid.memoryWarning();
        break;
      case 0x0a: {
        const m = json<{ delta: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.digitalCrown(m.delta);
        }
        break;
      }
      case 0x0b: {
        // Payload deltas are a fraction of the display; scale to device pixels.
        const m = json<{ dx: number; dy: number; x?: number; y?: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.scroll(m.dx * W, m.dy * H, W, H, m.x, m.y);
        }
        break;
      }
      case 0x0c:
        this.recordHidEvent(tag, {});
        this.hid.softwareKeyboard();
        break;
      case 0x0d: {
        const m = json<{ width?: number; height?: number }>();
        if (!m) break;
        const width = Number(m.width);
        const height = Number(m.height);
        if (!Number.isFinite(width) || !Number.isFinite(height)) break;
        this.recordHidEvent(tag, m);
        await this.capture.setPreferredScreenSize(Math.round(width), Math.round(height));
        break;
      }
      case 0x0e: {
        const m = json<{ pose?: string; hinge?: number }>();
        if (!m) break;
        this.recordHidEvent(tag, m);
        if (typeof m.pose === "string" && m.pose.trim()) {
          const spec = resolveDevicePose(m.pose);
          if (spec) {
            const from = this.hingeDegrees ?? 0;
            this.duoFold = { from, target: spec.hingeDegrees };
            let accepted = false;
            try {
              accepted = await this.hid.pose(m.pose, from);
              if (accepted) {
                clearTimeout(this.duoFoldTimer);
                this.duoFold = undefined;
                await this.followDuoState({ hingeDegrees: spec.hingeDegrees, orientations: {} });
                this.duoMonitor?.refreshOrientation();
                this.broadcastConfig();
                this.renderDuoFrame();
                return true;
              }
            } finally {
              clearTimeout(this.duoFoldTimer);
              this.duoFold = undefined;
              // Failed commands return to confirmed guest state; close() is
              // guarded by renderDuoFrame and cannot restart the animation.
              if (!accepted) this.renderDuoFrame();
            }
          }
        } else if (typeof m.hinge === "number" && Number.isFinite(m.hinge) && m.hinge >= 0 && m.hinge <= 180) {
          if (!await this.hid.hinge(m.hinge)) break;
          await this.followDuoState({ hingeDegrees: m.hinge, orientations: {} });
          this.duoMonitor?.refreshOrientation();
          this.broadcastConfig();
          this.renderDuoFrame();
          return true;
        }
        break;
      }
    }
  }

  private recordTouchEvent(payload: { type: string; x: number; y: number; edge?: number }): void {
    if (payload.type === "begin") {
      this.touchGestureLog = newTouchGesture(payload);
      return;
    }

    if (payload.type === "move") {
      let gesture = this.touchGestureLog;
      if (!gesture) {
        gesture = newTouchGesture(payload);
        this.touchGestureLog = gesture;
      }

      gesture.lastX = payload.x;
      gesture.lastY = payload.y;
      gesture.moveCount++;
      if (payload.edge != null) gesture.edge = payload.edge;
      if (touchGestureMoved(gesture)) {
        if (gesture.eventId == null) {
          const entry = recordEventLogEvent({
            device: this.udid,
            source: "hid",
            kind: "drag",
            action: "drag",
            summary: touchGestureSummary(gesture),
            details: this.touchGestureDetails(gesture, "drag", "move"),
          });
          gesture.eventId = entry.id;
        } else {
          // Keep the stored drag current without streaming every touchmove to the browser.
          updateEventLogEvent(
            gesture.eventId,
            {
              kind: "drag",
              action: "drag",
              summary: touchGestureSummary(gesture),
              details: this.touchGestureDetails(gesture, "drag", "move"),
            },
            { notify: false },
          );
        }
      }
      return;
    }

    if (payload.type === "end") {
      const gesture = this.touchGestureLog;
      if (gesture) {
        gesture.lastX = payload.x;
        gesture.lastY = payload.y;
        if (payload.edge != null) gesture.edge = payload.edge;
        if (gesture.moveCount > 0 && touchGestureMoved(gesture)) {
          if (gesture.eventId == null) {
            recordEventLogEvent({
              device: this.udid,
              source: "hid",
              kind: "drag",
              action: "drag",
              summary: touchGestureSummary(gesture),
              details: this.touchGestureDetails(gesture, "drag", "end"),
            });
          } else {
            updateEventLogEvent(gesture.eventId, {
              kind: "drag",
              action: "drag",
              summary: touchGestureSummary(gesture),
              details: this.touchGestureDetails(gesture, "drag", "end"),
            });
          }
        } else {
          recordEventLogEvent({
            device: this.udid,
            source: "hid",
            kind: "tap",
            action: "tap",
            summary: `Tap ${formatEventLogPoint(payload.x, payload.y)}`,
            details: this.touchGestureDetails(gesture, "tap"),
          });
        }
        this.touchGestureLog = undefined;
        return;
      }
    }

    this.recordHidEvent(0x03, payload);
  }

  private eventLogScreen(): { width: number; height: number } | undefined {
    return this.width > 0 && this.height > 0
      ? { width: this.width, height: this.height }
      : undefined;
  }

  private touchGestureDetails(
    gesture: TouchGestureLog,
    type: "drag" | "tap",
    phase?: "move" | "end",
  ): Record<string, unknown> {
    return {
      type,
      ...(phase ? { phase } : {}),
      start: { x: gesture.startX, y: gesture.startY },
      current: { x: gesture.lastX, y: gesture.lastY },
      moveCount: gesture.moveCount,
      ...(gesture.edge != null ? { edge: gesture.edge } : {}),
      ...(this.eventLogScreen() ? { screen: this.eventLogScreen() } : {}),
    };
  }

  private recordHidEvent(tag: number, payload: Record<string, unknown>): void {
    const event = eventLogEventForHidMessage(
      this.udid,
      tag,
      payload,
      this.eventLogScreen(),
    );
    if (event) recordEventLogEvent(event);
  }

  // ── Config ───────────────────────────────────────────────────────────────

  screenConfig(): { width: number; height: number; orientation: string; hingeDegrees?: number; duoViewOrientation?: string } {
    return { width: this.width, height: this.height, orientation: this.orientation, ...(this.hingeDegrees == null ? {} : { hingeDegrees: this.hingeDegrees, duoViewOrientation: this.duoViewOrientation }) };
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

  private bindSubscription(res: ServerResponse, unsubscribe: Unsubscribe): void {
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      this.streamResponses.delete(res);
      this.runCleanup("stream unsubscribe", unsubscribe);
    };
    if (res.writableEnded || res.destroyed) {
      cleanup();
      return;
    }
    res.once("close", cleanup);
    res.once("error", cleanup);
  }

  private trackStreamResponse(res: ServerResponse): boolean {
    if (this.isStopped() || res.writableEnded || res.destroyed) {
      if (!res.writableEnded && !res.destroyed) res.destroy();
      return false;
    }

    this.streamResponses.add(res);
    const release = () => {
      res.off("close", release);
      res.off("error", release);
      this.streamResponses.delete(res);
    };
    res.once("close", release);
    res.once("error", release);
    return true;
  }

  private runCleanup(operation: string, cleanup: Unsubscribe): void {
    try {
      void Promise.resolve(cleanup()).catch((error) => this.logCleanupError(operation, error));
    } catch (error) {
      this.logCleanupError(operation, error);
    }
  }

  private logCleanupError(operation: string, error: unknown): void {
    console.error(
      `[capture] ${operation} failed for ${this.udid}:`,
      error instanceof Error ? error.message : error,
    );
  }

  private handleStreamError(res: ServerResponse, error: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.sendJson(res, 503, {
      error: "capture_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
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
 * Get (lazily creating + starting) the in-process session for `udid`. Capture
 * failures are surfaced by stream endpoints and evict the session so the next
 * request can retry. The session otherwise lives until `closeDeviceSession`.
 */
export function getDeviceSession(udid: string): DeviceSession {
  let session = sessions.get(udid);
  if (!session) {
    const created = new DeviceSession(udid);
    session = created;
    sessions.set(udid, created);
    void created.start().catch(() => {
      // A reconnect can race `simctl shutdown`: remove the failed session so a
      // later Start creates a fresh native capture instead of reusing a rejected
      // promise. The rejection is observed here and by the endpoint that awaited
      // it, so it cannot terminate Node/Bun as an unhandled rejection.
      if (sessions.get(udid) !== created) return;
      sessions.delete(udid);
      created.close();
    });
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
