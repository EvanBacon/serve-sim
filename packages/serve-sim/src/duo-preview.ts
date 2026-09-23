import type { ServerResponse } from "http";
import { DuoRenderer, type DuoProjection } from "./duo-renderer";
import type { DuoPanel } from "./device-pose";

/** Matches the cubic ease-out sweep in the Duo guest HID helper. */
export const DUO_FOLD_DURATION_MS = 800;
const DUO_ROTATION_MS = 300;
/** Quiet period before the single 1500px sharpen. Motion resets it; a sharpened frame does not. */
export const DUO_SETTLE_MS = 180;
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

  constructor(private readonly options: {
    createRenderer: () => DuoPreviewRenderer;
    onProjection: (frame: Buffer) => void;
    onStreamError: (res: ServerResponse, error: unknown) => void;
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

  attach(res: ServerResponse): void {
    if (!this.renderer) {
      this.renderer = this.options.createRenderer();
      this.busy = false;
    }
    this.responses.add(res);
    this.requestFrame();
  }

  detach(res: ServerResponse): void {
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
    this.responses.clear();
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
      if (JSON.stringify(this.projection) !== JSON.stringify(projection)) {
        this.projection = projection;
        this.options.onProjection(Buffer.concat([Buffer.from([0x83]), Buffer.from(JSON.stringify(projection))]));
      }
      this.cached = { jpeg: snapshot, panel, angle, roll, png: rendered, sharpened: sharpen };
      this.delivered = new WeakSet();
      this.publishCached();
    }).catch((error) => {
      if (this.renderer !== renderer) return;
      for (const response of this.responses) this.options.onStreamError(response, error);
      renderer.close();
      this.renderer = undefined;
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
        this.writeFrame(response, png);
        this.delivered.add(response);
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
