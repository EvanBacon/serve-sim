import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulatorToolbar } from "../simulator/SimulatorToolbar";

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
