import type { ServerResponse } from "http";
import { DuoRenderer, DuoRendererError, type DuoProjection } from "./duo-renderer";
import type { DuoPanel } from "./device-pose";

/** Matches the cubic ease-out sweep in the Duo guest HID helper. */
export const DUO_FOLD_DURATION_MS = 800;
const DUO_ROTATION_MS = 300;
/** Quiet period before the single 1500px sharpen. Motion resets it; a sharpened frame does not. */
export const DUO_SETTLE_MS = 180;
/**
 * A 3D response must get its first PNG within this window or it is answered
 * with a 503 (stage `first_frame`) instead of a silent, never-ending stream.
 * Below the client's 12s watchdog and above the renderer's 10s render timeout,
 * so a timed-out render reports its own stage first.
 */
const DUO_FIRST_FRAME_TIMEOUT_MS = 11_000;
const FRAME_TRAILER = Buffer.from("\r\n", "ascii");

function copyBytes(jpeg: Uint8Array): Uint8Array {
  const copy = new Uint8Array(jpeg.byteLength);
  copy.set(jpeg);
  return copy;
}

/** Capture reuses one JPEG buffer in place, so identity is not enough. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );
}

export type DuoPreviewRenderer = Pick<DuoRenderer, "render" | "close">;

/** Renderer lifecycle notifications for logs, the event log, and diagnostics. */
export type DuoRendererEvent =
  | { phase: "ready"; firstFrameMs: number }
  | { phase: "failed"; error: DuoRendererError };

type PendingStart = { onFirstFrame: () => void; timer?: ReturnType<typeof setTimeout> };

function asRendererError(error: unknown): DuoRendererError {
  if (error instanceof DuoRendererError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DuoRendererError("worker_exit", message);
}

type Fold = { from: number; target: number; began: number };

/** Cubic ease-out from `from` to `target`. At `duration` the angle is `target`. */
export function easedFoldAngle(fold: Fold, now: number, duration = DUO_FOLD_DURATION_MS): number {
  const progress = Math.min(1, Math.max(0, (now - fold.began) / duration));
  if (progress >= 1) return fold.target;
  return fold.from + (fold.target - fold.from) * (1 - (1 - progress) ** 3);
}

/**
 * Duo 3D preview: renderer lifecycle, fold and rotation clocks, and the
 * multipart frame fan-out. Capture and HID stay on DeviceSession.
 * A named pose owns its clock from the moment it is sent. Hinge samples
 * update the confirmed angle and end the clock only once it has arrived
 * at the target. Samples with no local pose drive the angle directly.
 */
export class DuoPreview {
  private renderer?: DuoPreviewRenderer;
  private projection?: DuoProjection;
  private busy = false;
  private pending = false;
  private pendingSharpen = false;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private rendering?: { jpeg: Uint8Array; panel: DuoPanel; angle: number; roll: number };
  private cached?: { jpeg: Uint8Array; panel: DuoPanel; angle: number; roll: number; png: Uint8Array; sharpened: boolean };
  private delivered = new WeakSet<ServerResponse>();
  private foldTimer?: ReturnType<typeof setTimeout>;
  private rotationTimer?: ReturnType<typeof setTimeout>;
  private fold?: Fold;
  private hingeDegrees?: number;
  private viewRoll = 0;
  private viewOrientation = "portrait";
  private panel: DuoPanel = "cover";
  private jpeg: Uint8Array | null = null;
  private closed = false;
  private readonly responses = new Set<ServerResponse>();
  /** Responses whose headers are held until the first PNG (or a 503). */
  private readonly starting = new Map<ServerResponse, PendingStart>();
  private rendererStartedAt = 0;
  private rendererReady = false;
  private lastError?: { at: string; stage: string; reason: string };
  private framesPublished = 0;
  private lastFrameAt?: string;

  constructor(private readonly options: {
    /** `onFailure` reports worker failures that happen while no render is pending. */
    createRenderer: (onFailure: (error: DuoRendererError) => void) => DuoPreviewRenderer;
    onProjection: (frame: Buffer) => void;
    onStreamError: (res: ServerResponse, error: unknown) => void;
    onRendererEvent?: (event: DuoRendererEvent) => void;
    onFrameDelivered?: (res: ServerResponse) => void;
    firstFrameTimeoutMs?: number;
  }) {}

  get hinge(): number | undefined {
    return this.hingeDegrees;
  }

  get viewOrientationName(): string {
    return this.viewOrientation;
  }

  /** Confirmed guest angle. Does not retarget an in-flight pose clock. */
  noteHinge(degrees: number, now = performance.now()): void {
    this.hingeDegrees = degrees;
    const fold = this.fold;
    if (fold && now >= fold.began + DUO_FOLD_DURATION_MS && Math.abs(degrees - fold.target) < 0.6) {
      this.fold = undefined;
    }
  }

  /** Start the preview clock immediately. `from` is the angle on screen now. */
  beginPose(from: number, target: number, now = performance.now()): void {
    clearTimeout(this.foldTimer);
    this.fold = { from, target, began: now };
    this.tickFold(now);
  }

  cancelPose(): void {
    clearTimeout(this.foldTimer);
    this.fold = undefined;
    this.requestFrame();
  }

  /** The guest accepted the pose. The commanded angle becomes the confirmed one. */
  finishPose(target: number): void {
    clearTimeout(this.foldTimer);
    this.fold = undefined;
    this.hingeDegrees = target;
    this.requestFrame();
  }

  displayAngle(now = performance.now()): number {
    const fold = this.fold;
    if (!fold) return this.hingeDegrees ?? 0;
    return easedFoldAngle(fold, now);
  }

  setPanel(panel: DuoPanel): void {
    this.panel = panel;
  }

  onCapturedFrame(jpeg: Uint8Array): void {
    this.jpeg = jpeg;
    this.requestFrame();
  }

  projectionFrame(): Buffer | null {
    if (!this.projection) return null;
    return Buffer.concat([Buffer.from([0x83]), Buffer.from(JSON.stringify(this.projection))]);
  }

  animateRotation(orientation: string): void {
    clearTimeout(this.rotationTimer);
    this.viewOrientation = orientation;
    const target = { portrait: 0, landscape_left: -90, portrait_upside_down: -180, landscape_right: 90 }[orientation] ?? 0;
    const start = this.viewRoll;
    const delta = ((target - start + 540) % 360) - 180;
    const began = performance.now();
    const tick = () => {
      if (this.closed) return;
      const progress = Math.min(1, (performance.now() - began) / DUO_ROTATION_MS);
      const eased = progress * progress * (3 - 2 * progress);
      this.viewRoll = progress === 1 ? target : start + delta * eased;
      this.requestFrame();
      if (progress < 1) this.rotationTimer = setTimeout(tick, 16);
    };
    tick();
  }

  /**
   * Add a response. With `onFirstFrame`, nothing is written until the first
   * PNG is ready: the hook runs first (the caller's `writeHead`), and setup or
   * first-frame failures reach `onStreamError` while headers are still unsent.
   * Renderer construction errors throw synchronously.
   */
  attach(res: ServerResponse, start?: { onFirstFrame: () => void }): void {
    if (!this.renderer) {
      let renderer: DuoPreviewRenderer;
      try {
        renderer = this.options.createRenderer((error) => this.onRendererFailure(renderer, error));
      } catch (error) {
        const failure = asRendererError(error);
        this.noteFailure(failure);
        throw failure;
      }
      this.renderer = renderer;
      this.rendererStartedAt = performance.now();
      this.rendererReady = false;
      this.busy = false;
    }
    if (start) {
      const pending: PendingStart = { onFirstFrame: start.onFirstFrame };
      const timeout = this.options.firstFrameTimeoutMs ?? DUO_FIRST_FRAME_TIMEOUT_MS;
      pending.timer = setTimeout(() => this.failFirstFrame(res, timeout), timeout);
      pending.timer.unref?.();
      this.starting.set(res, pending);
    }
    this.responses.add(res);
    this.requestFrame();
  }

  detach(res: ServerResponse): void {
    this.clearStart(res);
    this.responses.delete(res);
    if (this.responses.size) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    this.renderer?.close();
    this.renderer = undefined;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    clearTimeout(this.foldTimer);
    clearTimeout(this.rotationTimer);
    this.fold = undefined;
    this.cached = undefined;
    this.renderer?.close();
    this.renderer = undefined;
    for (const res of this.starting.keys()) this.clearStart(res);
    this.responses.clear();
  }

  /** JSON-safe state for `/api/diagnostics`. */
  diagnostics(): Record<string, unknown> {
    return {
      renderer: this.renderer ? (this.rendererReady ? "ready" : "starting") : "absent",
      busy: this.busy,
      attached: this.responses.size,
      awaiting_first_frame: this.starting.size,
      hinge_degrees: this.hingeDegrees ?? null,
      panel: this.panel,
      has_capture_frame: this.jpeg != null,
      frames_published: this.framesPublished,
      last_frame_at: this.lastFrameAt ?? null,
      last_error: this.lastError ?? null,
    };
  }

  private clearStart(res: ServerResponse): void {
    const pending = this.starting.get(res);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.starting.delete(res);
  }

  private failFirstFrame(res: ServerResponse, timeoutMs: number): void {
    if (!this.starting.has(res)) return;
    // Say which precondition was missing: no capture frame, no hinge readback
    // (the preview never renders without one), or a render that never returned.
    const error = new DuoRendererError("first_frame", `No 3D frame within ${Math.round(timeoutMs / 1000)}s`, {
      has_capture_frame: this.jpeg != null,
      hinge_known: this.hingeDegrees != null || this.fold != null,
      renderer: this.renderer ? "running" : "absent",
      render_in_flight: this.busy,
    });
    this.noteFailure(error);
    this.detach(res);
    this.options.onStreamError(res, error);
  }

  private noteFailure(error: DuoRendererError): void {
    this.lastError = { at: new Date().toISOString(), stage: error.stage, reason: error.reason };
    this.options.onRendererEvent?.({ phase: "failed", error });
  }

  /** Worker died while idle (spawn error, crash between frames). */
  private onRendererFailure(renderer: DuoPreviewRenderer | undefined, error: DuoRendererError): void {
    if (!renderer || this.renderer !== renderer) return;
    this.renderer = undefined;
    this.noteFailure(error);
    for (const response of [...this.responses]) this.options.onStreamError(response, error);
  }

  requestFrame(sharpen = false): void {
    const renderer = this.renderer;
    const jpeg = this.jpeg;
    if (this.closed || !this.responses.size || !renderer || !jpeg || (this.hingeDegrees == null && !this.fold)) return;
    const panel = this.panel;
    const roll = this.viewRoll;
    const angle = this.displayAngle();
    const same = this.sameFrame(jpeg, panel, angle, roll, this.cached) || this.sameFrame(jpeg, panel, angle, roll, this.rendering);
    const sharpened = this.cached?.sharpened === true && this.sameFrame(jpeg, panel, angle, roll, this.cached);
    // Motion stays on the fast target. One sharpen follows, then identical
    // inputs reuse that PNG instead of sharpening again on every settle.
    if (sharpened) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    } else if (!sharpen && !same) {
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.requestFrame(true), DUO_SETTLE_MS);
      this.settleTimer.unref?.();
    } else if (!sharpen && !this.settleTimer) {
      this.settleTimer = setTimeout(() => this.requestFrame(true), DUO_SETTLE_MS);
      this.settleTimer.unref?.();
    }
    if (!this.busy && this.sameFrame(jpeg, panel, angle, roll, this.cached) && (sharpened || !sharpen)) {
      this.publishCached();
      return;
    }
    if (this.busy) {
      this.pending = true;
      if (sharpen) this.pendingSharpen = true;
      else if (!same) this.pendingSharpen = false;
      return;
    }
    this.busy = true;
    this.pending = false;
    this.pendingSharpen = false;
    if (sharpen) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
    // Copy before the await. DeviceSession mutates its JPEG buffer in place.
    const snapshot = copyBytes(jpeg);
    this.rendering = { jpeg: snapshot, panel, angle, roll };
    void renderer.render(snapshot, panel, angle, roll, sharpen).then(({ jpeg: rendered, projection }) => {
      if (this.closed || this.renderer !== renderer) return;
      if (!this.rendererReady) {
        this.rendererReady = true;
        this.options.onRendererEvent?.({ phase: "ready", firstFrameMs: Math.round(performance.now() - this.rendererStartedAt) });
      }
      if (JSON.stringify(this.projection) !== JSON.stringify(projection)) {
        this.projection = projection;
        this.options.onProjection(Buffer.concat([Buffer.from([0x83]), Buffer.from(JSON.stringify(projection))]));
      }
      this.cached = { jpeg: snapshot, panel, angle, roll, png: rendered, sharpened: sharpen };
      this.delivered = new WeakSet();
      this.publishCached();
    }).catch((error) => {
      if (this.renderer !== renderer) return;
      this.renderer = undefined;
      this.noteFailure(asRendererError(error));
      for (const response of [...this.responses]) this.options.onStreamError(response, error);
      renderer.close();
    }).finally(() => {
      if (this.renderer !== renderer) return;
      this.rendering = undefined;
      this.busy = false;
      if (this.pending) {
        const nextSharpen = this.pendingSharpen;
        this.pending = false;
        this.pendingSharpen = false;
        this.requestFrame(nextSharpen);
      }
    });
  }

  private sameFrame(jpeg: Uint8Array, panel: DuoPanel, angle: number, roll: number, frame?: { jpeg: Uint8Array; panel: DuoPanel; angle: number; roll: number }): boolean {
    return frame != null && frame.panel === panel && frame.angle === angle && frame.roll === roll && sameBytes(frame.jpeg, jpeg);
  }

  private publishCached(): void {
    const png = this.cached?.png;
    if (!png) return;
    for (const response of this.responses) {
      if (this.delivered.has(response)) continue;
      if (!response.destroyed && !response.writableEnded && response.writableLength === 0) {
        const pending = this.starting.get(response);
        if (pending) {
          this.clearStart(response);
          pending.onFirstFrame();
        }
        this.writeFrame(response, png);
        this.delivered.add(response);
        this.framesPublished++;
        this.lastFrameAt = new Date().toISOString();
        this.options.onFrameDelivered?.(response);
      }
    }
  }

  private tickFold(now = performance.now()): void {
    clearTimeout(this.foldTimer);
    if (this.closed || !this.fold) return;
    this.requestFrame();
    if (now < this.fold.began + DUO_FOLD_DURATION_MS) {
      this.foldTimer = setTimeout(() => this.tickFold(), 16);
      this.foldTimer.unref?.();
    }
  }

  private writeFrame(res: ServerResponse, frame: Uint8Array): void {
    const header = Buffer.from(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${frame.length}\r\n\r\n`, "ascii");
    res.write(header);
    res.write(frame);
    res.write(FRAME_TRAILER);
  }
}
