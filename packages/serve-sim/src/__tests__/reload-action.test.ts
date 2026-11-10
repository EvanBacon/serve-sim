import { describe, expect, test } from "bun:test";
import { canReloadApp, reloadAction } from "../client/utils/reload-action";

describe("canReloadApp", () => {
  test("offered for any foreground user app", () => {
    expect(canReloadApp({ bundleId: "com.example.app" })).toBe(true);
  });

  test("not offered on the home screen or without an app", () => {
    expect(canReloadApp({ bundleId: "com.apple.springboard" })).toBe(false);
    expect(canReloadApp({ bundleId: "" })).toBe(false);
    expect(canReloadApp(null)).toBe(false);
    expect(canReloadApp(undefined)).toBe(false);
  });
});

describe("reloadAction", () => {
  test("React Native: click reloads JS, Shift-click relaunches", () => {
    expect(reloadAction({ isReactNative: true, shiftKey: false })).toBe("js-reload");
    expect(reloadAction({ isReactNative: true, shiftKey: true })).toBe("relaunch");
  });

  test("other apps always relaunch", () => {
    expect(reloadAction({ isReactNative: false, shiftKey: false })).toBe("relaunch");
    expect(reloadAction({ isReactNative: false, shiftKey: true })).toBe("relaunch");
  });
});
