import { describe, expect, test } from "bun:test";
import { duoPreviewIsThreeD } from "../client/utils/duo-preview";

describe("duoPreviewIsThreeD", () => {
  test("defaults multi-display devices to the 3D view", () => {
    expect(duoPreviewIsThreeD(2, null)).toBe(true);
    expect(duoPreviewIsThreeD(2, "3d")).toBe(true);
  });

  test("keeps the flat stream when the viewer opts out", () => {
    expect(duoPreviewIsThreeD(2, "2d")).toBe(false);
  });

  test("leaves single-display devices on the flat stream", () => {
    expect(duoPreviewIsThreeD(0, null)).toBe(false);
    expect(duoPreviewIsThreeD(1, null)).toBe(false);
    expect(duoPreviewIsThreeD(1, "3d")).toBe(false);
  });
});
