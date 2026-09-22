import { describe, expect, test } from "bun:test";
import { DuoPreview, easedFoldAngle, DUO_FOLD_DURATION_MS } from "../duo-preview";

describe("duo fold clock", () => {
  test("eases from the commanded angle to the target over the guest sweep", () => {
    const began = 1_000;
    const fold = { from: 20, target: 180, began };
    expect(easedFoldAngle(fold, began)).toBe(20);
    expect(easedFoldAngle(fold, began + DUO_FOLD_DURATION_MS)).toBe(180);
    const mid = easedFoldAngle(fold, began + DUO_FOLD_DURATION_MS / 2);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(180);
  });

  test("a hinge sample does not retarget an in-flight pose", () => {
    const preview = new DuoPreview({
      createRenderer: () => ({ render: async () => { throw new Error("unused"); }, close() {} }),
      onProjection() {},
      onStreamError() {},
    });
    const now = performance.now();
    preview.noteHinge(20, now);
    preview.beginPose(20, 180, now);
    preview.noteHinge(65, now + 100);
    expect(preview.hinge).toBe(65);
    expect(preview.displayAngle(now + 100)).not.toBe(65);
    expect(preview.displayAngle(now + DUO_FOLD_DURATION_MS)).toBe(180);
    preview.noteHinge(180, now + DUO_FOLD_DURATION_MS);
    expect(preview.displayAngle(now + DUO_FOLD_DURATION_MS + 1)).toBe(180);
    preview.close();
  });
});
