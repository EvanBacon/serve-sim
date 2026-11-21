/**
 * Tracks a Duo fold transition so touches don't vanish into it.
 *
 * During a fold, SpringBoard's ContinuousFoldSnapshotOverlay owns touches
 * (`ownsHomeGesture; FGActive; suppressedBundles: <app>`) from "cloak
 * installed" until "snapshot removed at postflight", about 1.0–1.5 s. A touch
 * sent then is accepted by the HID stack and silently dropped by the guest.
 *
 * A fold starts on a pose command (`begin("pose")`) or the guest's "cloak
 * installed" (`overlay("start")`), and settles `graceMs` after the "overlay
 * reset" that follows "snapshot removed at postflight" (or `postflightMs`
 * after postflight if no reset shows). Measured: taps 168–197 ms after that
 * reset were still dropped while every tap ≥252 ms after it arrived, so the
 * grace covers the app's scene being re-hosted on the new panel. A pose that never shows the overlay (same panel, e.g. book ↔
 * open) settles after `noOverlayMs`; nothing holds input longer than `maxMs`.
 */
export type FoldSettle = "settled" | "no-overlay" | "timeout";

export interface FoldGateOptions {
  noOverlayMs?: number;
  maxMs?: number;
  postflightMs?: number;
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class FoldGate {
  private folding = false;
  private foldTarget?: "cover" | "inner";
  private sawOverlay = false;
  private waiters: Array<(how: FoldSettle) => void> = [];
  private noOverlayTimer?: unknown;
  private maxTimer?: unknown;
  private postflightTimer?: unknown;
  private sawPostflight = false;
  private readonly postflightMs: number;
  private readonly graceMs: number;
  private readonly noOverlayMs: number;
  private readonly maxMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(options: FoldGateOptions = {}) {
    this.noOverlayMs = options.noOverlayMs ?? 900;
    this.maxMs = options.maxMs ?? 2500;
    this.postflightMs = options.postflightMs ?? 250;
    this.graceMs = options.graceMs ?? 350;
    this.setTimer = options.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  get active(): boolean {
    return this.folding;
  }

  /** The panel the fold in progress is heading to, when a command said so. */
  get target(): "cover" | "inner" | undefined {
    return this.folding ? this.foldTarget : undefined;
  }

  /** A pose or hinge command that changes panels was sent. */
  begin(_source: "pose" | "hinge", target?: "cover" | "inner"): void {
    this.foldTarget = target;
    if (!this.folding) this.start();
    else this.restartMax();
    this.sawOverlay = false;
    this.clearTimer(this.noOverlayTimer);
    this.noOverlayTimer = this.setTimer(() => {
      if (!this.sawOverlay) this.settle("no-overlay");
    }, this.noOverlayMs);
  }

  /** A SpringBoard fold-overlay transition from the guest log. */
  overlay(phase: "start" | "postflight" | "reset"): void {
    if (phase === "start") {
      this.sawOverlay = true;
      this.sawPostflight = false;
      this.clearTimer(this.noOverlayTimer);
      this.clearTimer(this.postflightTimer);
      this.noOverlayTimer = this.postflightTimer = undefined;
      if (!this.folding) this.start();
      return;
    }
    if (!this.folding) return;
    if (phase === "postflight") {
      this.sawPostflight = true;
      this.clearTimer(this.postflightTimer);
      this.postflightTimer = this.setTimer(() => this.settle("settled"), this.postflightMs + this.graceMs);
      return;
    }
    // A reset before postflight is mid-transition.
    if (!this.sawPostflight) return;
    this.clearTimer(this.postflightTimer);
    this.postflightTimer = this.setTimer(() => this.settle("settled"), this.graceMs);
  }

  /** Resolves when the current fold settles; null when no fold is in progress. */
  whenSettled(): Promise<FoldSettle> | null {
    if (!this.folding) return null;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.settle("timeout");
  }

  private start(): void {
    this.folding = true;
    this.restartMax();
  }

  private restartMax(): void {
    this.clearTimer(this.maxTimer);
    this.maxTimer = this.setTimer(() => this.settle("timeout"), this.maxMs);
  }

  private settle(how: FoldSettle): void {
    this.clearTimer(this.noOverlayTimer);
    this.clearTimer(this.maxTimer);
    this.clearTimer(this.postflightTimer);
    this.noOverlayTimer = this.maxTimer = this.postflightTimer = undefined;
    this.sawPostflight = false;
    const wasFolding = this.folding;
    this.folding = false;
    this.foldTarget = undefined;
    this.sawOverlay = false;
    const waiters = this.waiters;
    this.waiters = [];
    if (wasFolding) for (const resolve of waiters) resolve(how);
  }
}
