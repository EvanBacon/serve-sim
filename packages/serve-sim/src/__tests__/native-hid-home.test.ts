import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import {
  HOME_FRONTMOST_PROBE_TIMEOUT_MS,
  NativeHid,
  SPRINGBOARD_BUNDLE_ID,
  homeButtonForFrontmost,
  type NativeHidDeps,
} from "../native";
import { deviceSupportsHomeIndicatorFlick } from "../devicekit-chrome";

const faceIdPortrait = {
  bundleId: SPRINGBOARD_BUNDLE_ID,
  supportsHomeIndicator: true,
  orientation: "portrait",
  inputShadowed: false,
} as const;

function hidWith(options: {
  buttons?: string[];
  axFrontmost?: (udid: string) => Promise<string>;
  getOrientation?: () => string | undefined;
  supportsHomeIndicator?: () => boolean;
  isInputShadowed?: () => boolean;
  isFoldable?: () => Promise<boolean>;
}) {
  const buttons: string[] = options.buttons ?? [];
  class FakeSimHID {
    constructor(_udid: string, _duoHelper: string) {}
    isFoldable = options.isFoldable ?? (async () => { throw new Error("not a duo"); });
    setDuoHelper = async () => {};
    button = async (name: string) => { buttons.push(name); return true; };
    touch = async () => {};
  }
  const hid = new NativeHid("UDID", {
    SimHID: FakeSimHID as unknown as NativeHidDeps["SimHID"],
    bundledDuoHelper: () => "/tmp/serve-sim-duo-hid-test",
    axFrontmost: options.axFrontmost,
    getOrientation: options.getOrientation,
    supportsHomeIndicator: options.supportsHomeIndicator,
    isInputShadowed: options.isInputShadowed,
  });
  return { hid, buttons };
}

describe("homeButtonForFrontmost", () => {
  test("leaves a foreground app via the SpringBoard launch path", () => {
    expect(homeButtonForFrontmost({ ...faceIdPortrait, bundleId: "com.apple.Preferences" })).toBe("home");
    expect(homeButtonForFrontmost({ ...faceIdPortrait, bundleId: "com.apple.mobilesafari" })).toBe("home");
  });

  test("uses a short home-indicator flick only on a Face ID device in portrait with SpringBoard frontmost", () => {
    expect(homeButtonForFrontmost(faceIdPortrait)).toBe("flick_home");
    expect(homeButtonForFrontmost({ ...faceIdPortrait, orientation: "portrait_upside_down" })).toBe("flick_home");
  });

  test("keeps the launch path when chrome, orientation, or Device Hub shadow is unknown or unsafe", () => {
    expect(homeButtonForFrontmost({ ...faceIdPortrait, bundleId: null })).toBe("home");
    expect(homeButtonForFrontmost({ ...faceIdPortrait, bundleId: undefined })).toBe("home");
    expect(homeButtonForFrontmost({ ...faceIdPortrait, bundleId: "" })).toBe("home");
    expect(homeButtonForFrontmost({ ...faceIdPortrait, supportsHomeIndicator: false })).toBe("home");
    expect(homeButtonForFrontmost({ ...faceIdPortrait, supportsHomeIndicator: undefined })).toBe("home");
    expect(homeButtonForFrontmost({ ...faceIdPortrait, orientation: "landscape_left" })).toBe("home");
    expect(homeButtonForFrontmost({ ...faceIdPortrait, orientation: null })).toBe("home");
    expect(homeButtonForFrontmost({ ...faceIdPortrait, orientation: undefined })).toBe("home");
    expect(homeButtonForFrontmost({ ...faceIdPortrait, inputShadowed: true })).toBe("home");
  });
});

describe("deviceSupportsHomeIndicatorFlick", () => {
  test("is true for Face ID chrome and false for a physical Home button or missing chrome", () => {
    if (!existsSync("/Library/Developer/DeviceKit/Chrome/phone.devicechrome")) return;
    expect(
      deviceSupportsHomeIndicatorFlick({
        name: "iPhone 17 Pro",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      }),
    ).toBe(true);
    expect(
      deviceSupportsHomeIndicatorFlick({
        name: "iPhone SE (3rd generation)",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation",
      }),
    ).toBe(false);
    expect(
      deviceSupportsHomeIndicatorFlick({
        name: "iPad Pro (9.7-inch)",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro--9-7-inch-",
      }),
    ).toBe(false);
    expect(
      deviceSupportsHomeIndicatorFlick({
        name: "unknown box",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Does-Not-Exist",
      }),
    ).toBe(false);
  });
});

describe("NativeHid.button home routing", () => {
  test("sends flick_home when SpringBoard is frontmost on a Face ID device in portrait", async () => {
    const { hid, buttons } = hidWith({
      axFrontmost: async () => JSON.stringify({ bundleId: SPRINGBOARD_BUNDLE_ID }),
      getOrientation: () => "portrait",
      supportsHomeIndicator: () => true,
      isInputShadowed: () => false,
    });
    expect(await hid.button("home")).toBe(true);
    expect(buttons).toEqual(["flick_home"]);
  });

  test("sends the launch path for a foreground app and does not wait for HID settle", async () => {
    // isFoldable resolving true/false starts the 1.5s guest-HID settle.
    // Launch must not wait for it; a hang here would also trip host-rpc's 2s race.
    const { hid, buttons } = hidWith({
      isFoldable: async () => false,
      axFrontmost: async () => JSON.stringify({ bundleId: "com.apple.Preferences" }),
      getOrientation: () => "portrait",
      supportsHomeIndicator: () => true,
    });
    const started = Date.now();
    expect(await hid.button("home")).toBe(true);
    expect(Date.now() - started).toBeLessThan(400);
    expect(buttons).toEqual(["home"]);
  });

  test("falls back to launch when the frontmost probe rejects, returns malformed JSON, or times out", async () => {
    const { hid: rejected, buttons: rejectedButtons } = hidWith({
      axFrontmost: async () => { throw new Error("ax down"); },
      getOrientation: () => "portrait",
      supportsHomeIndicator: () => true,
    });
    expect(await rejected.button("home")).toBe(true);
    expect(rejectedButtons).toEqual(["home"]);

    const { hid: malformed, buttons: malformedButtons } = hidWith({
      axFrontmost: async () => "not-json",
      getOrientation: () => "portrait",
      supportsHomeIndicator: () => true,
    });
    expect(await malformed.button("home")).toBe(true);
    expect(malformedButtons).toEqual(["home"]);

    const { hid: timedOut, buttons: timedOutButtons } = hidWith({
      axFrontmost: () => new Promise<string>(() => {}),
      getOrientation: () => "portrait",
      supportsHomeIndicator: () => true,
    });
    const started = Date.now();
    expect(await timedOut.button("home")).toBe(true);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(HOME_FRONTMOST_PROBE_TIMEOUT_MS - 20);
    expect(elapsed).toBeLessThan(HOME_FRONTMOST_PROBE_TIMEOUT_MS + 250);
    expect(timedOutButtons).toEqual(["home"]);
  });

  test("does not probe frontmost for a non-home button", async () => {
    let probed = 0;
    const { hid, buttons } = hidWith({
      axFrontmost: async () => { probed += 1; return JSON.stringify({ bundleId: SPRINGBOARD_BUNDLE_ID }); },
      getOrientation: () => "portrait",
      supportsHomeIndicator: () => true,
    });
    expect(await hid.button("power")).toBe(true);
    expect(probed).toBe(0);
    expect(buttons).toEqual(["power"]);
  });

  test("keeps the launch path in landscape, without a home indicator, or when Device Hub is shadowing input", async () => {
    for (const deps of [
      { getOrientation: () => "landscape_left", supportsHomeIndicator: () => true, isInputShadowed: () => false },
      { getOrientation: () => "portrait", supportsHomeIndicator: () => false, isInputShadowed: () => false },
      { getOrientation: () => "portrait", supportsHomeIndicator: () => true, isInputShadowed: () => true },
    ]) {
      const { hid, buttons } = hidWith({
        axFrontmost: async () => JSON.stringify({ bundleId: SPRINGBOARD_BUNDLE_ID }),
        ...deps,
      });
      expect(await hid.button("home")).toBe(true);
      expect(buttons).toEqual(["home"]);
    }
  });
});
