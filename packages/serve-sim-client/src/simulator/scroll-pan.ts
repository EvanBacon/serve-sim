import { WHEEL_LINE_HEIGHT_PX } from "./digitalCrown.js";

// Keep the virtual finger inside this band (normalized 0..1) so a drag always
// has room to travel. When a wheel delta would push it past the edge, the
// gesture lifts and re-anchors at the opposite edge to keep scrolling — this is
// what lets a long scroll pan further than a single screen height.
export const SCROLL_PAN_BAND_MARGIN = 0.15;

// A wheel event whose normalized magnitude is below this is treated as noise and
// ignored (mirrors the Digital Crown's MIN delta).
export const MIN_SCROLL_PAN_DELTA = 0.0005;

export interface TouchAction {
  type: "begin" | "move" | "end";
  x: number;
  y: number;
}

export interface ScrollPanState {
  active: boolean;
  x: number;
  y: number;
}

export function initialScrollPanState(): ScrollPanState {
  return { active: false, x: 0.5, y: 0.5 };
}

/** Convert a raw `WheelEvent.deltaX/Y` (respecting `deltaMode`) into CSS pixels. */
export function wheelDeltaToPixels(
  delta: number,
  deltaMode: number,
  axisLengthPx: number,
): number {
  if (!Number.isFinite(delta)) return 0;
  const safeAxis = Number.isFinite(axisLengthPx) && axisLengthPx > 0 ? axisLengthPx : 1;
  if (deltaMode === 1) return delta * WHEEL_LINE_HEIGHT_PX;
  if (deltaMode === 2) return delta * safeAxis;
  return delta;
}

function clampToBand(v: number, margin: number): number {
  const lo = margin;
  const hi = 1 - margin;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Fold one wheel tick into the running pan gesture, returning the updated state
 * and the touch actions to emit (begin/move/end).
 *
 * `dx`/`dy` are the *finger* deltas in normalized screen units, i.e. already
 * inverted from the scroll delta so content follows the scroll direction
 * (scrolling down reveals content below → the finger drags up). `anchorX/Y` is
 * the normalized cursor position used as the touch-down point when starting a
 * fresh gesture.
 */
export function stepScrollPan(
  state: ScrollPanState,
  dx: number,
  dy: number,
  anchorX: number,
  anchorY: number,
  margin: number = SCROLL_PAN_BAND_MARGIN,
): { state: ScrollPanState; actions: TouchAction[] } {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { state, actions: [] };
  }
  if (Math.abs(dx) < MIN_SCROLL_PAN_DELTA && Math.abs(dy) < MIN_SCROLL_PAN_DELTA) {
    return { state, actions: [] };
  }

  const actions: TouchAction[] = [];
  let { active, x, y } = state;

  if (!active) {
    x = clampToBand(anchorX, margin);
    y = clampToBand(anchorY, margin);
    actions.push({ type: "begin", x, y });
    active = true;
  }

  let remX = dx;
  let remY = dy;
  // Bound the loop: re-anchoring consumes at least one band-width per pass, so a
  // sane wheel delta resolves in a handful of iterations. The cap is a guard
  // against a pathological (e.g. NaN-adjacent) delta spinning forever.
  for (let i = 0; i < 64; i++) {
    const nx = x + remX;
    const ny = y + remY;
    const cx = clampToBand(nx, margin);
    const cy = clampToBand(ny, margin);
    if (cx !== x || cy !== y) actions.push({ type: "move", x: cx, y: cy });
    x = cx;
    y = cy;

    const overflowX = nx !== cx;
    const overflowY = ny !== cy;
    if (!overflowX && !overflowY) break;

    // Leftover travel past the wall, carried into a re-anchored gesture.
    remX = nx - cx;
    remY = ny - cy;
    actions.push({ type: "end", x, y });
    // Re-anchor the overflowing axis to the opposite edge so the drag can keep
    // going in the same direction; leave the in-band axis where it is.
    if (overflowX) x = remX < 0 ? 1 - margin : margin;
    if (overflowY) y = remY < 0 ? 1 - margin : margin;
    actions.push({ type: "begin", x, y });
  }

  return { state: { active, x, y }, actions };
}

/** Emit the touch-up that ends an in-progress pan (called on scroll inactivity). */
export function endScrollPan(state: ScrollPanState): {
  state: ScrollPanState;
  actions: TouchAction[];
} {
  if (!state.active) return { state, actions: [] };
  return {
    state: { ...state, active: false },
    actions: [{ type: "end", x: state.x, y: state.y }],
  };
}
