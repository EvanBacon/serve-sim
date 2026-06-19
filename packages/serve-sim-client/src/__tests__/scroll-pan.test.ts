import { describe, expect, test } from "bun:test";
import {
  SCROLL_PAN_BAND_MARGIN,
  endScrollPan,
  initialScrollPanState,
  stepScrollPan,
  wheelDeltaToPixels,
} from "../simulator/scroll-pan";

const LO = SCROLL_PAN_BAND_MARGIN;
const HI = 1 - SCROLL_PAN_BAND_MARGIN;

describe("wheelDeltaToPixels", () => {
  test("passes pixel-mode deltas through", () => {
    expect(wheelDeltaToPixels(120, 0, 800)).toBe(120);
    expect(wheelDeltaToPixels(-40, 0, 800)).toBe(-40);
  });

  test("scales line and page units", () => {
    expect(wheelDeltaToPixels(2, 1, 800)).toBe(32);
    expect(wheelDeltaToPixels(1, 2, 800)).toBe(800);
  });

  test("treats non-finite deltas as zero", () => {
    expect(wheelDeltaToPixels(Number.NaN, 0, 800)).toBe(0);
  });
});

describe("stepScrollPan", () => {
  test("first tick begins at the (clamped) cursor anchor", () => {
    const { state, actions } = stepScrollPan(initialScrollPanState(), 0, -0.1, 0.4, 0.6);
    expect(actions[0]).toEqual({ type: "begin", x: 0.4, y: 0.6 });
    expect(actions[1]?.type).toBe("move");
    expect(state.active).toBe(true);
    // Finger moved up by 0.1 from the anchor.
    expect(state.y).toBeCloseTo(0.5, 6);
  });

  test("an out-of-band anchor is pulled into the travel band", () => {
    const { actions } = stepScrollPan(initialScrollPanState(), 0, -0.05, 0.5, 0.98);
    expect(actions[0]).toEqual({ type: "begin", x: 0.5, y: HI });
  });

  test("subsequent ticks only move (no new begin)", () => {
    let s = initialScrollPanState();
    ({ state: s } = stepScrollPan(s, 0, -0.05, 0.5, 0.5));
    const { actions } = stepScrollPan(s, 0, -0.05, 0.5, 0.5);
    expect(actions.every((a) => a.type === "move")).toBe(true);
  });

  test("re-anchors at the opposite edge when a drag runs past the wall", () => {
    // Start mid-screen, then scroll far enough up to overflow the top of the band.
    let s = initialScrollPanState();
    ({ state: s } = stepScrollPan(s, 0, 0, 0.5, 0.5)); // anchor only (no-op delta below min)
    s = { active: true, x: 0.5, y: LO + 0.05 };
    const { state, actions } = stepScrollPan(s, 0, -0.2, 0.5, 0.5);
    // Should hit the top wall, lift, and re-begin at the bottom edge.
    const types = actions.map((a) => a.type);
    expect(types).toContain("end");
    const endIdx = types.indexOf("end");
    expect(actions[endIdx]).toEqual({ type: "end", x: 0.5, y: LO });
    expect(actions[endIdx + 1]).toEqual({ type: "begin", x: 0.5, y: HI });
    expect(state.active).toBe(true);
    expect(state.y).toBeLessThan(HI);
  });

  test("ignores sub-threshold and non-finite deltas", () => {
    const s = initialScrollPanState();
    expect(stepScrollPan(s, 0, 0, 0.5, 0.5).actions).toHaveLength(0);
    expect(stepScrollPan(s, Number.NaN, 0, 0.5, 0.5).actions).toHaveLength(0);
    // State is untouched (no gesture started).
    expect(stepScrollPan(s, 0, 0, 0.5, 0.5).state.active).toBe(false);
  });

  test("horizontal deltas pan along x", () => {
    const { state, actions } = stepScrollPan(initialScrollPanState(), 0.1, 0, 0.5, 0.5);
    expect(actions[0]?.type).toBe("begin");
    expect(state.x).toBeCloseTo(0.6, 6);
    expect(state.y).toBeCloseTo(0.5, 6);
  });
});

describe("endScrollPan", () => {
  test("emits a single end at the current finger position", () => {
    const s = { active: true, x: 0.3, y: 0.7 };
    const { state, actions } = endScrollPan(s);
    expect(actions).toEqual([{ type: "end", x: 0.3, y: 0.7 }]);
    expect(state.active).toBe(false);
  });

  test("is a no-op when no gesture is active", () => {
    const { actions } = endScrollPan(initialScrollPanState());
    expect(actions).toHaveLength(0);
  });
});
