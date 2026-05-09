import { describe, expect, test } from "bun:test";
import { androidKeyCodeForHidUsage, parseAdbDevices, parseAndroidDisplayConfig, parsePngSize } from "../android";

describe("Android helpers", () => {
  test("parses adb device listings", () => {
    const devices = parseAdbDevices(`
List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
0123456789ABCDEF unauthorized usb:336592896X transport_id:2
`);

    expect(devices).toEqual([
      {
        serial: "emulator-5554",
        state: "device",
        product: "sdk_gphone64_arm64",
        model: "sdk_gphone64_arm64",
        name: "sdk_gphone64_arm64",
      },
      {
        serial: "0123456789ABCDEF",
        state: "unauthorized",
        product: undefined,
        model: undefined,
        name: "0123456789ABCDEF",
      },
    ]);
  });

  test("reads dimensions from adb screencap PNG data", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(png.buffer);
    view.setUint32(16, 1080, false);
    view.setUint32(20, 2400, false);

    expect(parsePngSize(png)).toEqual({ width: 1080, height: 2400 });
  });

  test("rejects non-PNG screencap data", () => {
    expect(parsePngSize(new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });

  test("reads dimensions and orientation from Android display dumps", () => {
    expect(parseAndroidDisplayConfig(`
DisplayPolicy
  DisplayFrames w=2340 h=1080 r=1
    `)).toEqual({
      width: 2340,
      height: 1080,
      orientation: "landscape_left",
    });
  });

  test("maps HID keyboard usage codes to Android keycodes", () => {
    expect(androidKeyCodeForHidUsage(0x04)).toBe("29");
    expect(androidKeyCodeForHidUsage(0x1e)).toBe("8");
    expect(androidKeyCodeForHidUsage(0x28)).toBe("KEYCODE_ENTER");
    expect(androidKeyCodeForHidUsage(0x52)).toBe("KEYCODE_DPAD_UP");
    expect(androidKeyCodeForHidUsage(0xe3)).toBeNull();
  });
});
