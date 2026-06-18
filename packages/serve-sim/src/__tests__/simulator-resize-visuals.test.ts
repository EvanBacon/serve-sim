import { describe, expect, test } from "bun:test";
import {
  getSimulatorFrameMaxWidth,
  RESIZE_MAIN_STROKE_W,
  SIMULATOR_RESIZE_ABSOLUTE_MIN_WIDTH,
  SIMULATOR_RESIZE_HANDLE_DUR_HOT,
  SIMULATOR_RESIZE_HANDLE_DUR_IDLE,
  SIMULATOR_RESIZE_MIN_WIDTH,
} from "../client/utils/simulator-resize";

describe("simulator resize visual tuning", () => {
  test("uses a faint idle arc and faster highlight timing", () => {
    expect(RESIZE_MAIN_STROKE_W.idle).toBeLessThan(3);
    expect(SIMULATOR_RESIZE_HANDLE_DUR_HOT).toBe("0.16s");
    expect(SIMULATOR_RESIZE_HANDLE_DUR_IDLE).toBe("0.2s");
  });

  test("allows the frame to shrink below the preferred minimum in short viewports", () => {
    const maxWidth = getSimulatorFrameMaxWidth(320, 1280, 576, 1179 / 2556);

    expect(maxWidth).toBeLessThan(SIMULATOR_RESIZE_MIN_WIDTH);
    expect(maxWidth).toBeGreaterThanOrEqual(SIMULATOR_RESIZE_ABSOLUTE_MIN_WIDTH);
  });
});
