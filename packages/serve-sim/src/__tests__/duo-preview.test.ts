import { describe, expect, test } from "bun:test";
import { duoPreviewIsThreeD } from "../client/utils/duo-preview";

describe("duoPreviewIsThreeD", () => {
  test("uses the device model for multi-display devices", () => {
    expect(duoPreviewIsThreeD(2)).toBe(true);
  });
  test("leaves single-display devices on their existing stream", () => {
    expect(duoPreviewIsThreeD(0)).toBe(false);
    expect(duoPreviewIsThreeD(1)).toBe(false);
  });
});
