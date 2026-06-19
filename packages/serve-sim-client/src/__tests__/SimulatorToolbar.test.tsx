import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulatorToolbar, homeButtonCommand } from "../simulator/SimulatorToolbar";

const exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });

describe("SimulatorToolbar.Title", () => {
  test("can hide the runtime subtitle", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar
        exec={exec}
        deviceUdid="booted"
        deviceName="iPhone 16 (26.5)"
        deviceRuntime="iOS-26-5"
        streaming
      >
        <SimulatorToolbar.Title hideSubtitle />
      </SimulatorToolbar>,
    );

    expect(html).toContain("iPhone 16 (26.5)");
    expect(html).not.toContain("iOS-26-5");
  });

  test("can hide the chevron", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar
        exec={exec}
        deviceUdid="booted"
        deviceName="iPhone 16 (26.5)"
        streaming
      >
        <SimulatorToolbar.Title hideChevron />
      </SimulatorToolbar>,
    );

    expect(html).toContain("iPhone 16 (26.5)");
    expect(html).not.toContain("<polyline");
  });
});

describe("homeButtonCommand", () => {
  // Xcode 26+ silently drops the HID home press, so phones/pads must relaunch
  // SpringBoard instead of going through `serve-sim button home`.
  test("relaunches SpringBoard for a known iphone udid", () => {
    expect(homeButtonCommand("iphone", "BOOTED-UDID")).toBe(
      "xcrun simctl launch BOOTED-UDID com.apple.springboard",
    );
  });

  test("relaunches SpringBoard for ipad simulators", () => {
    expect(homeButtonCommand("ipad", "udid")).toContain("com.apple.springboard");
  });

  test("drives Simulator.app's Device > Home menu for watch simulators", () => {
    const cmd = homeButtonCommand("watch", "udid");
    expect(cmd).toContain("osascript");
    expect(cmd).not.toContain("com.apple.springboard");
  });

  test("falls back to the HID button command when no udid is known", () => {
    expect(homeButtonCommand("iphone", null)).toBe("serve-sim button home");
  });
});

describe("SimulatorToolbar.Button", () => {
  test("uses a rounded hover surface for icon actions", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
        <SimulatorToolbar.Button aria-label="Capture">icon</SimulatorToolbar.Button>
      </SimulatorToolbar>,
    );

    expect(html).toContain("border-radius:12px");
  });

  test("renders a tooltip from the aria label", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
        <SimulatorToolbar.HomeButton />
      </SimulatorToolbar>,
    );

    expect(html).toContain('role="tooltip"');
    expect(html).toContain(">Home</span>");
  });

  test("uses title text for the tooltip without relying on native title", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
        <SimulatorToolbar.Button aria-label="Capture" title="Screenshot">
          icon
        </SimulatorToolbar.Button>
      </SimulatorToolbar>,
    );

    expect(html).toContain('role="tooltip"');
    expect(html).toContain(">Screenshot</span>");
    expect(html).not.toContain('title="Screenshot"');
  });
});
