import { describe, expect, test } from "bun:test";
import { digitalCrownDeltaFromWheel } from "../simulator/digitalCrown";

describe("Digital Crown wheel mapping", () => {
  test("preserves browser wheel direction", () => {
    expect(digitalCrownDeltaFromWheel(120, 0, 496)).toBe(120);
    expect(digitalCrownDeltaFromWheel(-120, 0, 496)).toBe(-120);
  });

  test("normalizes line and page wheel units to pixels", () => {
    expect(digitalCrownDeltaFromWheel(2, 1, 496)).toBe(32);
    expect(digitalCrownDeltaFromWheel(1, 2, 496)).toBe(200);
    expect(digitalCrownDeltaFromWheel(-1, 2, 496)).toBe(-200);
  });

  test("ignores tiny, zero, and non-finite deltas", () => {
    expect(digitalCrownDeltaFromWheel(0, 0, 496)).toBeNull();
    expect(digitalCrownDeltaFromWheel(0.001, 0, 496)).toBeNull();
    expect(digitalCrownDeltaFromWheel(Number.NaN, 0, 496)).toBeNull();
  });
});
