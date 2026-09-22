import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceHingeControls } from "../client/components/device-hinge-controls";

function render(angle = 0) {
  return renderToStaticMarkup(
    <DeviceHingeControls
      angle={angle}
      onChange={() => {}}
      onPose={() => {}}
    />,
  );
}

describe("DeviceHingeControls", () => {
  test("renders pose presets without a caption or fold-gesture toggle", () => {
    const html = render();
    expect(html).toContain('aria-label="Fold pose"');
    expect(html).toContain("Hold Alt (Option) for precise hinge control");
    expect(html).toContain("Folded pose");
    expect(html).toContain("Cracked open pose");
    expect(html).toContain("Fully open pose");
    expect(html).not.toContain("Fold gesture mode");
    expect(html).not.toContain("Hold ⌥ Alt for precise hinge control");
    expect(html).not.toContain("Pinch or drag to fold");
    expect(html).not.toContain("flex-col");
  });

  test("marks the matching pose as pressed", () => {
    const html = render(130);
    expect(html).toContain("Cracked open pose");
    expect(html).toContain('aria-pressed="true"');
  });
});
