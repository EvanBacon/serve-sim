// Parse the `serve-sim gesture <json>` argument into a validated sequence of
// touch steps for the WS touch opcode (0x03).
//
// A complete touch (begin → move × N → end) must ride ONE WebSocket: each CLI
// invocation opens its own socket, so back-to-back `gesture` calls register as
// a long-press, never a drag. Accepting an array here lets a single invocation
// replay the whole sequence on one socket — the only way the CLI can express a
// drag/scroll/swipe.

const TOUCH_TYPES = ["begin", "move", "end"] as const;
export type TouchType = (typeof TOUCH_TYPES)[number];

export type SingleTouch = {
  type: TouchType;
  x: number;
  y: number;
  edge?: number;
};

export type MultiTouch = {
  type: TouchType;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

/** One touch event, plus how long to wait after sending it (ms). */
export type GestureStep = (SingleTouch | MultiTouch) & { delayMs?: number };

/** Inter-step delay when a step doesn't specify `delayMs` (~one 60fps frame). */
export const DEFAULT_STEP_DELAY_MS = 16;

function isNormalized(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function validateStep(step: unknown, index: number, total: number): GestureStep {
  const label = total > 1 ? `step ${index + 1}/${total}` : "gesture";
  if (typeof step !== "object" || step === null || Array.isArray(step)) {
    throw new Error(`Invalid ${label}: expected an object like {"type":"begin","x":0.5,"y":0.5}, got ${JSON.stringify(step)}`);
  }
  const { type, x, y, x1, y1, x2, y2, delayMs } = step as Record<string, unknown>;
  if (typeof type !== "string" || !(TOUCH_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid ${label}: "type" must be one of ${TOUCH_TYPES.join("|")}, got ${JSON.stringify(type)}`);
  }
  const single = isNormalized(x) && isNormalized(y);
  const multi = isNormalized(x1) && isNormalized(y1) && isNormalized(x2) && isNormalized(y2);
  if (!single && !multi) {
    throw new Error(
      `Invalid ${label}: needs normalized 0..1 coords — either {"x","y"} or {"x1","y1","x2","y2"} — got ${JSON.stringify(step)}`,
    );
  }
  if (delayMs !== undefined && (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0)) {
    throw new Error(`Invalid ${label}: "delayMs" must be a non-negative number, got ${JSON.stringify(delayMs)}`);
  }
  return step as GestureStep;
}

/**
 * Parse the gesture CLI argument: a single touch object, or an array of touch
 * steps replayed in order on one socket. Throws with the failing step's index
 * and the exact problem.
 */
export function parseGestureSteps(jsonStr: string): GestureStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Invalid JSON: ${jsonStr}`);
  }
  const raw = Array.isArray(parsed) ? parsed : [parsed];
  if (raw.length === 0) {
    throw new Error("Gesture array is empty — provide at least one touch step.");
  }
  return raw.map((step, i) => validateStep(step, i, raw.length));
}

/** The wire payload for a step: everything except the CLI-only `delayMs`. */
export function stepPayload(step: GestureStep): SingleTouch | MultiTouch {
  const { delayMs: _delayMs, ...touch } = step;
  return touch;
}
