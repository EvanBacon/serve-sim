import { describe, expect, test } from "bun:test";
import {
  androidInputTextArg,
  parseAdbDevices,
  parseWmSize,
  shutdownAndroidDevice,
} from "../android-device";
import { androidKeyCodeForHidUsage, parsePngDimensions } from "../android-helper";

describe("Android device parsing", () => {
  test("parses adb devices -l output", () => {
    expect(parseAdbDevices(`List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
ZY22 offline usb:336592896X product:oriole model:Pixel_6 device:oriole
`)).toEqual([
      {
        serial: "emulator-5554",
        state: "device",
        attrs: {
          product: "sdk_gphone64_arm64",
          model: "sdk_gphone64_arm64",
          device: "emu64a",
          transport_id: "1",
        },
      },
      {
        serial: "ZY22",
        state: "offline",
        attrs: {
          usb: "336592896X",
          product: "oriole",
          model: "Pixel_6",
          device: "oriole",
        },
      },
    ]);
  });

  test("parses wm size output", () => {
    expect(parseWmSize("Physical size: 1080x2400")).toEqual({ width: 1080, height: 2400 });
    expect(parseWmSize("Override size: 720x1280")).toEqual({ width: 720, height: 1280 });
    expect(parseWmSize("no size here")).toBeNull();
  });

  test("escapes text for adb input text", () => {
    expect(androidInputTextArg("Hi there 100%")).toBe("Hi%sthere%s100%25");
    expect(androidInputTextArg("a&b")).toBe("a\\&b");
  });

  test("refuses to power off physical Android devices", () => {
    expect(() => shutdownAndroidDevice("ZY22")).toThrow("Physical Android devices");
  });
});

describe("Android helper parsing", () => {
  test("reads PNG dimensions from IHDR", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    view.setUint32(16, 1080);
    view.setUint32(20, 2400);
    expect(parsePngDimensions(png)).toEqual({ width: 1080, height: 2400 });
  });

  test("maps common HID usages to Android keycodes", () => {
    expect(androidKeyCodeForHidUsage(0x04)).toBe(29);
    expect(androidKeyCodeForHidUsage(0x1e)).toBe(8);
    expect(androidKeyCodeForHidUsage(0x27)).toBe(7);
    expect(androidKeyCodeForHidUsage(0x2c)).toBe(62);
    expect(androidKeyCodeForHidUsage(0xe1)).toBeNull();
  });
});
