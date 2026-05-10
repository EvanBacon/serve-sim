import { describe, expect, test } from "bun:test";
import {
  androidKeyCodeForHidUsage,
  parseAdbDevices,
  parseAndroidAccessibilityTree,
  parseAndroidDisplayConfig,
  parsePngSize,
} from "../android";

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

  test("maps uiautomator XML to the existing accessibility tree shape", () => {
    const nodes = parseAndroidAccessibilityTree(`
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" enabled="true" bounds="[0,0][1080,2340]">
    <node index="0" text="Search &amp; Maps" resource-id="com.example:id/search" class="android.widget.EditText" content-desc="Search field" enabled="true" bounds="[24,100][1056,180]" />
    <node index="1" text="" resource-id="com.example:id/submit" class="android.widget.Button" content-desc="Submit" enabled="false" bounds="[800,200][1056,320]" />
  </node>
</hierarchy>UI hierchary dumped to: /dev/tty
`, { width: 1080, height: 2340, orientation: "portrait" });

    expect(nodes).toEqual([{
      AXUniqueId: null,
      AXLabel: null,
      AXValue: null,
      enabled: true,
      frame: { x: 0, y: 0, width: 1080, height: 2340 },
      role_description: "FrameLayout",
      type: "FrameLayout",
      children: [
        {
          AXUniqueId: "com.example:id/search@[24,100][1056,180]",
          AXLabel: "Search field",
          AXValue: "Search & Maps",
          enabled: true,
          frame: { x: 24, y: 100, width: 1032, height: 80 },
          role_description: "Text Field",
          type: "EditText",
          children: [],
        },
        {
          AXUniqueId: "com.example:id/submit@[800,200][1056,320]",
          AXLabel: "Submit",
          AXValue: null,
          enabled: false,
          frame: { x: 800, y: 200, width: 256, height: 120 },
          role_description: "Button",
          type: "Button",
          children: [],
        },
      ],
    }]);
  });

  test("keeps text-only Android node values", () => {
    const nodes = parseAndroidAccessibilityTree(`
<hierarchy rotation="0">
  <node text="Typed value" resource-id="com.example:id/input" class="android.widget.EditText" content-desc="" enabled="true" bounds="[0,0][100,40]" />
</hierarchy>
`, { width: 100, height: 40, orientation: "portrait" });

    expect(nodes[0]?.AXLabel).toBe("Typed value");
    expect(nodes[0]?.AXValue).toBe("Typed value");
  });

  test("rejects malformed uiautomator output", () => {
    expect(() =>
      parseAndroidAccessibilityTree("UI hierchary dumped to: /dev/tty", {
        width: 1080,
        height: 2340,
        orientation: "portrait",
      })
    ).toThrow("uiautomator dump did not contain hierarchy XML");
  });

  test("maps HID keyboard usage codes to Android keycodes", () => {
    expect(androidKeyCodeForHidUsage(0x04)).toBe("29");
    expect(androidKeyCodeForHidUsage(0x1e)).toBe("8");
    expect(androidKeyCodeForHidUsage(0x28)).toBe("KEYCODE_ENTER");
    expect(androidKeyCodeForHidUsage(0x52)).toBe("KEYCODE_DPAD_UP");
    expect(androidKeyCodeForHidUsage(0xe3)).toBeNull();
  });
});
