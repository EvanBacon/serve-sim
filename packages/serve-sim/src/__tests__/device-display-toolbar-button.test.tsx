import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceDisplayToolbarButton } from "../client/components/device-display-toolbar-button";
import { SimulatorToolbar } from "../client/simulator/SimulatorToolbar";
import type { DeviceDisplayDescriptor } from "../client/utils/grid";

const exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });

const chrome = {
  identifier: "phone14",
  frame: { width: 100, height: 200 },
  body: { x: 0, y: 0, width: 100, height: 200 },
  screen: { x: 10, y: 10, width: 80, height: 180 },
  insets: { top: 10, left: 10, bottom: 10, right: 10 },
  outerCornerRadius: 20,
  innerCornerRadius: 16,
  screenRadius: 14,
  compositeImage: "PhoneComposite",
  slice: null,
  corner: null,
  buttons: [],
} satisfies DeviceDisplayDescriptor["chrome"];

const displays: DeviceDisplayDescriptor[] = [
  {
    id: "primary",
    role: "cover",
    name: "Cover",
    width: 1398,
    height: 2034,
    chrome: { ...chrome, identifier: "phone15" },
  },
  {
    id: "primary-1",
    role: "inner",
    name: "Inner",
    width: 2007,
    height: 2853,
    chrome,
  },
];

function render(selectedId: string | null) {
  return renderToStaticMarkup(
    <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
      <DeviceDisplayToolbarButton displays={displays} selectedId={selectedId} onSelect={() => {}} />
    </SimulatorToolbar>,
  );
}

describe("DeviceDisplayToolbarButton", () => {
  test("renders Cover and Inner display switches", () => {
    const html = render("primary-1");
    expect(html).toContain("Cover display");
    expect(html).toContain("Inner display");
    expect(html).toContain("aria-pressed=\"true\"");
  });

  test("hides when the device has only one display", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
        <DeviceDisplayToolbarButton
          displays={displays.slice(0, 1)}
          selectedId="primary"
          onSelect={() => {}}
        />
      </SimulatorToolbar>,
    );
    expect(html).not.toContain("Cover display");
  });
});
