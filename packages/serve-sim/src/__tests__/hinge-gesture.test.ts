import { expect, test } from "bun:test";
import { hingeAngleForPinch, hingeAngleForWheel } from "../client/utils/hinge-gesture";

test("pinch out opens even from fully closed; pinch in closes from flat", () => {
  expect(hingeAngleForPinch(0, 2)).toBe(180);
  expect(hingeAngleForPinch(180, 0.5)).toBe(0);
  expect(hingeAngleForPinch(90, 1)).toBe(90);
  expect(hingeAngleForPinch(90, Math.SQRT2)).toBeCloseTo(180);
  expect(hingeAngleForPinch(90, 0.01)).toBe(0);
  expect(hingeAngleForPinch(90, NaN)).toBe(90);
  expect(hingeAngleForPinch(90, 0)).toBe(90);
});

test("trackpad pinch uses Chromium's control-wheel direction and clamps", () => {
  expect(hingeAngleForWheel(90, -20)).toBe(110);
  expect(hingeAngleForWheel(90, 20)).toBe(70);
  expect(hingeAngleForWheel(0, 1000)).toBe(0);
  expect(hingeAngleForWheel(180, -1000)).toBe(180);
});
