import { describe, expect, test } from "bun:test";
import { canReloadApp } from "../client/utils/reload-action";

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
