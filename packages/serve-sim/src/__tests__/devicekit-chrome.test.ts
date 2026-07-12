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
    // The exact screen extent depends on which DeviceKit chrome assets the
    // installed SDK ships (composite image vs. profile metadata yields px vs.
    // pt), so assert it resolves to a sane positive value rather than pinning
    // a single machine's SDK geometry.
    expect(chrome?.screen.width).toBeGreaterThan(0);
    expect(chrome?.buttons.some((button) => button.name === "digital-crown")).toBe(true);
  });

  test("resolves Device Hub-style placeholder assets from CoreTypes metadata", () => {
    if (!existsSync("/System/Library/CoreServices/CoreTypes.bundle/Contents/Library/MobileDevices.bundle")) return;

    // The CoreTypes icon set ships with the host SDK, so older runner images
    // (e.g. GitHub's macos-latest) may not carry every current device's asset.
    // When a device's asset is absent the resolver returns null — skip that
    // case rather than pinning one machine's SDK. When it does resolve, assert
    // the metadata mapping (icon name) and that cropping produced sane bounds.
    const expectPlaceholder = (
      device: { name: string; deviceTypeIdentifier: string },
      expectedName: string,
    ) => {
      const resolved = resolveDevicePlaceholderAsset(device);
      if (!resolved) return;
      expect(resolved.name).toBe(expectedName);
      expect(resolved.width).toBeGreaterThan(0);
      expect(resolved.height).toBeGreaterThan(0);
    };

    expectPlaceholder(
      {
        name: "iPhone 17 Pro",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      },
      "com.apple.iphone-17-pro-2",
    );
    expectPlaceholder(
      {
        name: "Apple Watch Ultra 3 (49mm)",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-3-49mm",
      },
      "com.apple.apple-watch-ultra-3-8",
    );
    expectPlaceholder(
      {
        name: "iPad Air 11-inch (M4)",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4",
      },
      "ipad-air-11-inch-m4",
    );
  });
});
