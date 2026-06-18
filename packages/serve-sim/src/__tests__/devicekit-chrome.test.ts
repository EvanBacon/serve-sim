import { existsSync } from "fs";
import { describe, expect, test } from "bun:test";
import {
  bareChromeIdentifier,
  logicalScreenSizeFromProfile,
  parsePdfPageSize,
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
});
