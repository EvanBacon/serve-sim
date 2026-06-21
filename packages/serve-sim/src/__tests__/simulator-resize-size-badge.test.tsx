import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulatorResizeSizeBadge } from "../client/components/simulator-resize-size-badge";

describe("SimulatorResizeSizeBadge", () => {
  test("uses the shared panel backdrop color", () => {
    const html = renderToStaticMarkup(
      <SimulatorResizeSizeBadge width={393} height={852} visible />,
    );

    expect(html).toContain("bg-panel-bg");
  });
});
