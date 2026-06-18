export const SIMULATOR_RESIZE_MIN_WIDTH = 280;
export const SIMULATOR_RESIZE_ABSOLUTE_MIN_WIDTH = 180;
export const SIMULATOR_RESIZE_MAX_SCALE = 3;
export const SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME = 136;
export const SIMULATOR_RESIZE_DRAG_TRANSITION = "width 70ms linear";
export const SIMULATOR_RESIZE_LAYOUT_TRANSITION = "width 0.24s cubic-bezier(0.22, 1, 0.36, 1)";
export const SIMULATOR_RESIZE_PAGE_TRANSITION = "padding-right 0.24s cubic-bezier(0.22, 1, 0.36, 1)";

// ─── Visual constants for the curved-arc corner handle ────────────────────
export const SIMULATOR_RESIZE_EASE = "cubic-bezier(0.2, 0.82, 0.22, 1)";
export const SIMULATOR_RESIZE_EASE_OUT = "cubic-bezier(0.4, 0, 0.2, 1)";
/** Subtle spring overshoot for the handle scale when becoming hot. Falls back to `EASE` if `linear()` isn't supported. */
export const SIMULATOR_RESIZE_SPRING =
  "linear(0, 0.32 9%, 0.62 18%, 0.85 27%, 1.01 36%, 1.07 45%, 1.05 56%, 1.02 70%, 1)";
export const SIMULATOR_RESIZE_HANDLE_DUR_HOT = "0.16s";
export const SIMULATOR_RESIZE_HANDLE_DUR_IDLE = "0.2s";
/** Extra invisible stroke padding around the visible arc so the pointer target stays generous. */
export const SIMULATOR_RESIZE_HIT_SLOP = 5;

export type ResizeVisualPhase = "idle" | "hover" | "drag";
export type SimulatorResizeArc = { d: string; dFill: string; viewBoxSize: number };

export const RESIZE_SCALE: Record<ResizeVisualPhase, number> = {
  idle: 1,
  hover: 1.09,
  drag: 1.12,
};

export const RESIZE_MAIN_STROKE: Record<ResizeVisualPhase, string> = {
  idle: "#686e78",
  hover: "#b7bbc2",
  drag: "#f4f6fa",
};

export const RESIZE_MAIN_STROKE_W: Record<ResizeVisualPhase, number> = {
  idle: 2.65,
  hover: 4.15,
  drag: 4.65,
};

export const RESIZE_HANDLE_OPACITY: Record<ResizeVisualPhase, number> = {
  idle: 0.38,
  hover: 0.86,
  drag: 1,
};

/** `linear()` easing landed in Chrome 113 / Safari 17.4 / Firefox 112. Cubic-bezier is the fallback. */
let supportsLinearEasingCache: boolean | null = null;
export function supportsLinearEasing(): boolean {
  if (supportsLinearEasingCache != null) return supportsLinearEasingCache;
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;
  supportsLinearEasingCache = CSS.supports("animation-timing-function", "linear(0, 1)");
  return supportsLinearEasingCache;
}

/** Max rubber-band overshoot in CSS px on either side of the bound. */
export const SIMULATOR_RESIZE_RUBBER_BAND_MAX = 40;
/** Distance within which the release tween snaps to a detent. */
export const SIMULATOR_RESIZE_DETENT_RADIUS = 14;
/** Spring tuning for the post-release settle. */
export const SIMULATOR_RESIZE_SPRING_STIFFNESS = 240;
export const SIMULATOR_RESIZE_SPRING_DAMPING = 30;
/** Velocity is projected forward this many seconds to choose the spring target on release. */
export const SIMULATOR_RESIZE_MOMENTUM_S = 0.15;
/** Pointer-sample window used for velocity estimation. */
export const SIMULATOR_RESIZE_VELOCITY_WINDOW_MS = 80;
export const SIMULATOR_RESIZE_VELOCITY_HISTORY_MS = 150;
/** Debounce window for writing the persisted scale. */
export const SIMULATOR_RESIZE_PERSIST_DEBOUNCE_MS = 250;
export const SIMULATOR_RESIZE_SCALE_STORAGE_KEY = "serve-sim:simulator-frame-scale";

export function getSimulatorFrameMaxWidth(
  defaultWidth: number,
  viewportWidth: number,
  viewportHeight: number,
  aspectRatio: number,
) {
  const scaledMaxWidth = defaultWidth * SIMULATOR_RESIZE_MAX_SCALE;
  const viewportMaxWidth =
    viewportWidth > 0
      ? Math.max(SIMULATOR_RESIZE_ABSOLUTE_MIN_WIDTH, viewportWidth - 48)
      : scaledMaxWidth;
  const viewportMaxHeight =
    viewportHeight > 0 && Number.isFinite(aspectRatio) && aspectRatio > 0
      ? Math.max(
          SIMULATOR_RESIZE_ABSOLUTE_MIN_WIDTH,
          (viewportHeight - SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME) * aspectRatio,
        )
      : scaledMaxWidth;
  return Math.max(
    SIMULATOR_RESIZE_ABSOLUTE_MIN_WIDTH,
    Math.min(scaledMaxWidth, viewportMaxWidth, viewportMaxHeight),
  );
}

export function clampSimulatorFrameWidth(
  value: number,
  defaultWidth: number,
  viewportWidth: number,
  viewportHeight: number,
  aspectRatio: number,
) {
  const maxWidth = getSimulatorFrameMaxWidth(defaultWidth, viewportWidth, viewportHeight, aspectRatio);
  const minWidth = Math.min(SIMULATOR_RESIZE_MIN_WIDTH, maxWidth);
  return Math.min(maxWidth, Math.max(minWidth, value));
}

export function restoredSimulatorFrameWidth(
  defaultWidth: number,
  viewportWidth: number,
  viewportHeight: number,
  aspectRatio: number,
  storedScale: number | null | undefined,
) {
  const restored = Number.isFinite(storedScale)
    ? defaultWidth * storedScale!
    : defaultWidth;
  return clampSimulatorFrameWidth(
    restored,
    defaultWidth,
    viewportWidth,
    viewportHeight,
    aspectRatio,
  );
}

/** Round to whole device pixels so the frame / stream don't shimmer at sub-pixel widths. */
export function roundToDevicePixel(value: number): number {
  if (!Number.isFinite(value)) return value;
  const dpr = typeof window !== "undefined" ? Math.max(1, window.devicePixelRatio || 1) : 1;
  return Math.round(value * dpr) / dpr;
}

/** iOS-style asymptotic resistance for drags past a bound, capped so it can't escape layout. */
export function rubberBandResistance(over: number, dimension: number): number {
  if (over <= 0 || dimension <= 0) return 0;
  const c = 0.55;
  const computed = (over * dimension * c) / (dimension + c * over);
  return Math.min(SIMULATOR_RESIZE_RUBBER_BAND_MAX, computed);
}

/** Pull `value` toward the nearest detent within `radius`. */
export function snapToDetent(value: number, detents: number[], radius: number): number {
  let best = value;
  let bestDist = radius;
  for (const d of detents) {
    const dist = Math.abs(value - d);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

/** RAF-driven spring tween. Returns a cancel function. */
export function springTo(opts: {
  from: number;
  to: number;
  velocity: number;
  stiffness: number;
  damping: number;
  onUpdate: (x: number) => void;
  onComplete?: () => void;
}): () => void {
  const { from, to, velocity, stiffness, damping, onUpdate, onComplete } = opts;
  const PRECISION = 0.4;
  const MAX_DT = 1 / 30;
  let x = from;
  let v = velocity;
  let last = performance.now();
  let raf = 0;
  let cancelled = false;
  const step = (now: number) => {
    if (cancelled) return;
    const dt = Math.min((now - last) / 1000, MAX_DT);
    last = now;
    const a = -stiffness * (x - to) - damping * v;
    v += a * dt;
    x += v * dt;
    if (Math.abs(v) < PRECISION && Math.abs(x - to) < PRECISION) {
      onUpdate(to);
      onComplete?.();
      return;
    }
    onUpdate(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    if (raf) cancelAnimationFrame(raf);
  };
}

/** Px/second velocity inferred from the tail of the sample buffer. */
export function estimateReleaseVelocity(samples: { t: number; x: number }[]): number {
  if (samples.length < 2) return 0;
  const now = samples[samples.length - 1]!;
  let prev = samples[0]!;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (now.t - samples[i]!.t >= SIMULATOR_RESIZE_VELOCITY_WINDOW_MS) {
      prev = samples[i]!;
      break;
    }
  }
  const dt = (now.t - prev.t) / 1000;
  return dt > 0 ? (now.x - prev.x) / dt : 0;
}
