import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceHingeControls } from "../client/components/device-hinge-controls";

function render(folding = false, angle = 0) {
  return renderToStaticMarkup(
    <DeviceHingeControls
      angle={angle}
      folding={folding}
      onFoldingChange={() => {}}
      onChange={() => {}}
      onPose={() => {}}
    />,
  );
}

describe("DeviceHingeControls", () => {
  test("renders pose presets in one strip without a caption", () => {
    const html = render();
    expect(html).toContain('aria-label="Fold pose"');
    expect(html).toContain("Hold Alt (Option) for precise hinge control");
    expect(html).toContain("Folded pose");
    expect(html).toContain("Cracked open pose");
    expect(html).toContain("Fully open pose");
    expect(html).not.toContain("Hold ⌥ Alt for precise hinge control");
    expect(html).not.toContain("Pinch or drag to fold");
    expect(html).not.toContain("flex-col");
  });

  test("fold gesture stays a pressed control inside the strip", () => {
    const html = render(true, 130);
    expect(html).toContain("Fold gesture mode");
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("Pinch or drag to fold");
  });
});
