// Parse the `serve-sim gesture <json>` argument into a validated sequence of
// touch steps, and turn them into HID frames for the input socket.
//
// A complete touch (begin → move × N → end) should be sent by ONE invocation.
// Split across separate `gesture` calls, the finger stays down between them,
// and any realistic gap (e.g. separate agent tool calls) makes the held
// `begin` read as a long-press (text selection in web views) instead of a
// drag. Accepting an array lets one invocation send the whole sequence with
// controlled per-step timing.

import type { SimulatorOrientation } from "./client/types";
import { displayMultiTouchToRaw, displayTouchToRaw } from "./touch-remap";

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

/** WS opcodes: single touch (`SimHID.touch`) and two-finger touch (`multiTouch`). */
export const TOUCH_TAG = 0x03;
export const MULTI_TOUCH_TAG = 0x05;

export interface GestureFrame {
  tag: number;
  payload: SingleTouch | MultiTouch;
  delayMs: number;
}

const SINGLE_KEYS = ["x", "y"] as const;
const MULTI_KEYS = ["x1", "y1", "x2", "y2"] as const;

function isNormalized(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

export function isMultiTouch(step: SingleTouch | MultiTouch): step is MultiTouch {
  return "x1" in step;
}

function validateStep(step: unknown, index: number, total: number): GestureStep {
  const label = total > 1 ? `step ${index + 1}/${total}` : "gesture";
  if (typeof step !== "object" || step === null || Array.isArray(step)) {
    throw new Error(`Invalid ${label}: expected an object like {"type":"begin","x":0.5,"y":0.5}, got ${JSON.stringify(step)}`);
  }
  const fields = step as Record<string, unknown>;
  const { type, x, y, x1, y1, x2, y2, edge, delayMs } = fields;
  if (typeof type !== "string" || !(TOUCH_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid ${label}: "type" must be one of ${TOUCH_TYPES.join("|")}, got ${JSON.stringify(type)}`);
  }
  // A step is one shape or the other. Mixing them is ambiguous (which finger
  // count did the caller mean?), so any multi-touch key alongside x/y fails.
  const hasSingle = SINGLE_KEYS.some((k) => k in fields);
  const hasMulti = MULTI_KEYS.some((k) => k in fields);
  if (hasSingle && hasMulti) {
    throw new Error(
      `Invalid ${label}: use either single-touch {"x","y"} or multi-touch {"x1","y1","x2","y2"}, not both — got ${JSON.stringify(step)}`,
    );
  }
  const single = isNormalized(x) && isNormalized(y);
  const multi = isNormalized(x1) && isNormalized(y1) && isNormalized(x2) && isNormalized(y2);
  if (!single && !multi) {
    throw new Error(
      `Invalid ${label}: needs normalized 0..1 coords — either {"x","y"} or {"x1","y1","x2","y2"} — got ${JSON.stringify(step)}`,
    );
  }
  if (edge !== undefined) {
    if (multi) {
      throw new Error(`Invalid ${label}: "edge" is only supported on single-touch {"x","y"} steps`);
    }
    if (typeof edge !== "number" || !Number.isInteger(edge) || edge < 0 || edge > 4) {
      throw new Error(`Invalid ${label}: "edge" must be an integer 0..4, got ${JSON.stringify(edge)}`);
    }
  }
  if (delayMs !== undefined && (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0)) {
    throw new Error(`Invalid ${label}: "delayMs" must be a non-negative number, got ${JSON.stringify(delayMs)}`);
  }
  const t = type as TouchType;
  const wait = delayMs === undefined ? {} : { delayMs: delayMs as number };
  if (multi) {
    return { type: t, x1: x1 as number, y1: y1 as number, x2: x2 as number, y2: y2 as number, ...wait };
  }
  return { type: t, x: x as number, y: y as number, ...(edge === undefined ? {} : { edge: edge as number }), ...wait };
}

/**
 * Parse the gesture CLI argument: a single touch object, or an array of touch
 * steps sent in order on one socket. Throws with the failing step's index
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

/**
 * HID frames for `sendAckedInput`: display coords remapped to the raw portrait
 * frame for `orientation`, single touches on 0x03 and two-finger touches on
 * 0x05. A step's `delayMs` is the wait after it, so it becomes the next
 * frame's delay; the first frame goes out immediately.
 */
export function gestureStepFrames(
  steps: readonly GestureStep[],
  orientation: SimulatorOrientation | null | undefined,
): GestureFrame[] {
  return steps.map((step, i) => {
    const touch = stepPayload(step);
    const delayMs = i === 0 ? 0 : steps[i - 1]!.delayMs ?? DEFAULT_STEP_DELAY_MS;
    return isMultiTouch(touch)
      ? { tag: MULTI_TOUCH_TAG, payload: displayMultiTouchToRaw(touch, orientation), delayMs }
      : { tag: TOUCH_TAG, payload: displayTouchToRaw(touch, orientation), delayMs };
  });
}
