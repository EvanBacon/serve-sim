import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulatorResizeSizeBadge } from "../client/components/simulator-resize-size-badge";

describe("SimulatorResizeSizeBadge", () => {
  test("uses a translucent panel backdrop so backdrop-blur shows through", () => {
    const html = renderToStaticMarkup(
      <SimulatorResizeSizeBadge width={393} height={852} visible />,
    );

    expect(html).toContain("bg-panel-bg-translucent");
    expect(html).toContain("backdrop-blur-md");
  });
});
