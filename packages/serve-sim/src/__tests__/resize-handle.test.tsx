import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResizeHandle } from "../client/components/resize-handle";

const noop = () => {};

describe("ResizeHandle", () => {
  test("tracks the interior edge of a floating panel on either side", () => {
    const left = renderToStaticMarkup(
      <ResizeHandle
        panelWidth={320}
        visible
        onPointerDown={noop}
        ariaLabel="Resize simulators sidebar"
        side="left"
      />,
    );
    const right = renderToStaticMarkup(
      <ResizeHandle
        panelWidth={320}
        visible
        onPointerDown={noop}
        ariaLabel="Resize tools panel"
        side="right"
      />,
    );

    // 12px float inset + panel width, then center the 16px hit target on the
    // interior border (inset + width - 9).
    expect(left).toContain("left:323px");
    expect(right).toContain("right:323px");
    expect(left).toContain("fixed top-3 bottom-3");
    expect(right).toContain("fixed top-3 bottom-3");
    expect(left).not.toContain("fixed top-0 bottom-0");
  });
});
