import { describe, expect, test } from "bun:test";
import {
  RESIZE_MAIN_STROKE_W,
  SIMULATOR_RESIZE_HANDLE_DUR_HOT,
  SIMULATOR_RESIZE_HANDLE_DUR_IDLE,
} from "../client/utils/simulator-resize";

describe("simulator resize visual tuning", () => {
  test("uses a faint idle arc and faster highlight timing", () => {
    expect(RESIZE_MAIN_STROKE_W.idle).toBeLessThan(3);
    expect(SIMULATOR_RESIZE_HANDLE_DUR_HOT).toBe("0.16s");
    expect(SIMULATOR_RESIZE_HANDLE_DUR_IDLE).toBe("0.2s");
  });
});
