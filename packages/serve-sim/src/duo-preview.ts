import type { ServerResponse } from "http";
import { DuoRenderer, type DuoProjection } from "./duo-renderer";
import type { DuoPanel } from "./device-pose";

/** Matches the cubic ease-out sweep in the Duo guest HID helper. */
export const DUO_FOLD_DURATION_MS = 800;
const DUO_ROTATION_MS = 300;
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
  private cached?: { jpeg: Uint8Array; panel: DuoPanel; angle: number; roll: number; png: Uint8Array };
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
    this.renderer?.close();
    this.renderer = undefined;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.foldTimer);
    clearTimeout(this.rotationTimer);
    this.fold = undefined;
    this.cached = undefined;
    this.renderer?.close();
    this.renderer = undefined;
    this.responses.clear();
  }

  requestFrame(): void {
    const renderer = this.renderer;
    const jpeg = this.jpeg;
    if (this.closed || !this.responses.size || !renderer || !jpeg || (this.hingeDegrees == null && !this.fold)) return;
    const panel = this.panel;
    const roll = this.viewRoll;
    const angle = this.displayAngle();
    // Idle used to re-render at 3000px after 180 ms. Skip that, and skip the
    // native render entirely when this frame's inputs are already encoded.
    if (!this.busy && this.matchesCached(jpeg, panel, angle, roll)) {
      this.publishCached();
      return;
    }
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    this.pending = false;
    // Copy before the await. DeviceSession mutates its JPEG buffer in place.
    const snapshot = copyBytes(jpeg);
    void renderer.render(snapshot, panel, angle, roll, false).then(({ jpeg: rendered, projection }) => {
      if (this.closed || this.renderer !== renderer) return;
      if (JSON.stringify(this.projection) !== JSON.stringify(projection)) {
        this.projection = projection;
        this.options.onProjection(Buffer.concat([Buffer.from([0x83]), Buffer.from(JSON.stringify(projection))]));
      }
      this.cached = { jpeg: snapshot, panel, angle, roll, png: rendered };
      this.delivered = new WeakSet();
      this.publishCached();
    }).catch((error) => {
      if (this.renderer !== renderer) return;
      for (const response of this.responses) this.options.onStreamError(response, error);
      renderer.close();
      this.renderer = undefined;
    }).finally(() => {
      if (this.renderer !== renderer) return;
      this.busy = false;
      if (this.pending) this.requestFrame();
    });
  }

  private matchesCached(jpeg: Uint8Array, panel: DuoPanel, angle: number, roll: number): boolean {
    const cached = this.cached;
    return cached != null && cached.panel === panel && cached.angle === angle && cached.roll === roll && sameBytes(cached.jpeg, jpeg);
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
