import { describe, expect, test } from "bun:test";
import type { DeviceKitChromeDescriptor } from "../client/utils/grid";
import {
  deviceKitScreenRadius,
  deviceKitScreenSlotStyle,
} from "../client/components/device-chrome-frame";

const chrome = {
  identifier: "phone11",
  frame: { width: 120, height: 240 },
  body: { x: 4, y: 4, width: 112, height: 232 },
  screen: { x: 12, y: 20, width: 96, height: 200 },
  insets: { top: 20, left: 12, bottom: 20, right: 12 },
  outerCornerRadius: 20,
  innerCornerRadius: 16,
  screenRadius: 16,
  compositeImage: "PhoneComposite",
  slice: null,
  corner: null,
  buttons: [],
} satisfies DeviceKitChromeDescriptor;

describe("deviceKitScreenSlotStyle", () => {
  test("framed slot matches the DeviceKit screen cutout", () => {
    const style = deviceKitScreenSlotStyle(chrome, true);
    expect(style.left).toBe("10%");
    expect(style.top).toBe(`${(20 / 240) * 100}%`);
    expect(style.width).toBe("80%");
    expect(style.height).toBe(`${(200 / 240) * 100}%`);
    expect(style.zIndex).toBe(2);
    expect(style.borderRadius).toBe(deviceKitScreenRadius(chrome));
  });

  test("unframed slot fills the wrapper so hide/show does not remount the stream", () => {
    expect(deviceKitScreenSlotStyle(chrome, false)).toEqual({
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 2,
      borderRadius: 0,
    });
  });
});
