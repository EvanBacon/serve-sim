import { describe, expect, test } from "bun:test";
import { wheelDeltaToPixels } from "../client/simulator/scroll-wheel";

describe("wheelDeltaToPixels", () => {
  test("passes pixel-mode deltas through", () => {
    expect(wheelDeltaToPixels(120, 0, 800)).toBe(120);
    expect(wheelDeltaToPixels(-40, 0, 800)).toBe(-40);
  });

  test("scales line and page units", () => {
    expect(wheelDeltaToPixels(2, 1, 800)).toBe(32);
    expect(wheelDeltaToPixels(1, 2, 800)).toBe(800);
    expect(wheelDeltaToPixels(-1, 2, 800)).toBe(-800);
  });

  test("treats non-finite deltas as zero", () => {
    expect(wheelDeltaToPixels(Number.NaN, 0, 800)).toBe(0);
  });

  test("falls back to a safe axis length", () => {
    expect(wheelDeltaToPixels(1, 2, 0)).toBe(1);
  });
});
