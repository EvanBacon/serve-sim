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
    expect(html).not.toContain("Hold Alt");
    expect(html).toContain("Closed pose");
    expect(html).toContain("Tent pose");
    expect(html).toContain("Table pose");
    expect(html).toContain("Book pose");
    expect(html).toContain("Open pose");
    expect(html).not.toContain("Fold gesture mode");
    expect(html).not.toContain("Hold ⌥ Alt for precise hinge control");
    expect(html).not.toContain("Pinch or drag to fold");
    expect(html).not.toContain("flex-col");
  });

  test("marks the matching pose as pressed", () => {
    const html = render(130);
    expect(html).toContain("Book pose");
    expect(html).toContain('aria-pressed="true"');
  });
});
