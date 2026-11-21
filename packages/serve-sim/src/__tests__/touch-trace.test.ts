import { describe, expect, test } from "bun:test";
import { formatTouchTrace, panelForSize, touchTraceEnabled } from "../touch-trace";

describe("touch trace", () => {
  test("is opt-in", () => {
    expect(touchTraceEnabled({})).toBe(false);
    expect(touchTraceEnabled({ SERVE_SIM_TOUCH_TRACE: "0" })).toBe(false);
    expect(touchTraceEnabled({ SERVE_SIM_TOUCH_TRACE: "" })).toBe(false);
    expect(touchTraceEnabled({ SERVE_SIM_TOUCH_TRACE: "1" })).toBe(true);
  });

  test("maps Duo framebuffer sizes to panels in either orientation", () => {
    expect(panelForSize(1398, 2034)).toBe("cover");
    expect(panelForSize(2034, 1398)).toBe("cover");
    expect(panelForSize(2007, 2853)).toBe("inner");
    expect(panelForSize(1179, 2556)).toBeNull();
    expect(panelForSize(0, 0)).toBeNull();
  });

  test("flags a size that disagrees with the active panel", () => {
    const line = formatTouchTrace({
      tag: 3, udid: "U", frame: { type: "begin", x: 0.5, y: 0.5 }, width: 1398, height: 2034,
      orientation: "portrait", duo: { hingeDegrees: 180, primaryPanel: "inner", activePanel: "inner", followedCover: false },
      shadowed: false, result: true, elapsedMs: 3,
    }, 1_000);
    expect(line.startsWith("[touch-trace] server ")).toBe(true);
    const json = JSON.parse(line.slice("[touch-trace] server ".length));
    expect(json.sizePanel).toBe("cover");
    expect(json.sizeMatchesActivePanel).toBe(false);
    expect(json.wall).toBe(1);
  });

  test("single-display devices report no panel match", () => {
    const json = JSON.parse(formatTouchTrace({
      tag: 3, udid: "U", frame: {}, width: 1179, height: 2556, orientation: "portrait",
      shadowed: null, result: false, elapsedMs: 0,
    }).slice("[touch-trace] server ".length));
    expect(json.sizeMatchesActivePanel).toBeNull();
  });
});
