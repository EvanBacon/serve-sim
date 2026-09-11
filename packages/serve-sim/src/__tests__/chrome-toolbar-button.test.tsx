import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChromeToolbarButton } from "../client/components/chrome-toolbar-button";
import { SimulatorToolbar } from "../client/simulator/SimulatorToolbar";

const exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });

function render(hideChrome: boolean) {
  return renderToStaticMarkup(
    <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
      <ChromeToolbarButton hideChrome={hideChrome} onToggle={() => {}} />
    </SimulatorToolbar>,
  );
}

describe("ChromeToolbarButton", () => {
  test("labels the opt-in hide mode and is unpressed by default", () => {
    const html = render(false);
    expect(html).toContain("Hide device frame");
    expect(html).toContain('aria-pressed="false"');
  });

  test("presses and relabels when the frame is hidden", () => {
    const html = render(true);
    expect(html).toContain("Show device frame");
    expect(html).toContain('aria-pressed="true"');
  });
});
