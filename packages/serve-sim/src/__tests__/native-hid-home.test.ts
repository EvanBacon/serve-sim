import { describe, expect, test } from "bun:test";
import { homeButtonForFrontmost, SPRINGBOARD_BUNDLE_ID } from "../native";

describe("homeButtonForFrontmost", () => {
  test("leaves a foreground app via the SpringBoard launch path", () => {
    expect(homeButtonForFrontmost("com.apple.Preferences")).toBe("home");
    expect(homeButtonForFrontmost("com.apple.mobilesafari")).toBe("home");
  });

  test("uses a short home-indicator flick when SpringBoard is already frontmost", () => {
    expect(homeButtonForFrontmost(SPRINGBOARD_BUNDLE_ID)).toBe("flick_home");
  });

  test("falls back to the launch path when frontmost is unknown", () => {
    expect(homeButtonForFrontmost(null)).toBe("home");
    expect(homeButtonForFrontmost(undefined)).toBe("home");
    expect(homeButtonForFrontmost("")).toBe("home");
  });
});
