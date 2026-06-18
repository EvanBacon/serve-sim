import { existsSync } from "fs";
import { describe, expect, test } from "bun:test";
import {
  bareChromeIdentifier,
  logicalScreenSizeFromProfile,
  parsePdfPageSize,
  resolveDevicePlaceholderAsset,
  resolveDeviceKitChrome,
} from "../devicekit-chrome";

describe("DeviceKit chrome helpers", () => {
  test("strips Apple's chrome bundle prefix", () => {
    expect(bareChromeIdentifier("com.apple.dt.devicekit.chrome.phone11")).toBe("phone11");
    expect(bareChromeIdentifier("watch2")).toBe("watch2");
  });

  test("parses MediaBox page dimensions from a PDF payload", () => {
    expect(parsePdfPageSize("2 0 obj << /Type /Pages /MediaBox [0 0 65 97] >>")).toEqual({
      width: 65,
      height: 97,
    });
  });

  test("prefers explicit main screen plist dimensions when present", () => {
    expect(
      logicalScreenSizeFromProfile(
        {
          mainScreenWidth: 1206,
          mainScreenHeight: 2622,
          mainScreenScale: 3,
        },
        "phone11",
      ),
    ).toEqual({ width: 402, height: 874 });
  });

  test("resolves stock watch chrome from installed DeviceKit assets when available", () => {
    if (!existsSync("/Library/Developer/DeviceKit/Chrome/watch2.devicechrome")) return;

    const chrome = resolveDeviceKitChrome({
      name: "renamed clone",
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-SE-3-40mm",
    });

    expect(chrome?.identifier).toBe("watch2");
    expect(chrome?.slice?.topLeft).toBe("WatchTL");
    expect(chrome?.screen.width).toBe(324);
    expect(chrome?.buttons.some((button) => button.name === "digital-crown")).toBe(true);
  });

  test("resolves Device Hub-style placeholder assets from CoreTypes metadata", () => {
    if (!existsSync("/System/Library/CoreServices/CoreTypes.bundle/Contents/Library/MobileDevices.bundle")) return;

    const phone = resolveDevicePlaceholderAsset({
      name: "iPhone 17 Pro",
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    });
    const watch = resolveDevicePlaceholderAsset({
      name: "Apple Watch Ultra 3 (49mm)",
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-3-49mm",
    });
    const tabletFallback = resolveDevicePlaceholderAsset({
      name: "iPad Air 11-inch (M4)",
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4",
    });

    expect(phone).toEqual({ name: "com.apple.iphone-17-pro-2", width: 950, height: 1024 });
    expect(watch).toEqual({ name: "com.apple.apple-watch-ultra-3-8", width: 499, height: 795 });
    expect(tabletFallback).toEqual({ name: "ipad-air-11-inch-m4", width: 895, height: 986 });
  });
});
