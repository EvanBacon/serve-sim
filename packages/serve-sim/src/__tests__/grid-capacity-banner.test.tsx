import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GridCapacityBanner } from "../client/components/grid-capacity-banner";

describe("GridCapacityBanner", () => {
  test("labels the capacity estimate as iOS simulator capacity", () => {
    const html = renderToStaticMarkup(
      <GridCapacityBanner
        report={{
          availableBytes: 4_000_000_000,
          estimatedAdditional: 2,
          perSimAvgBytes: 1_000_000_000,
          perSimSource: "estimated",
          runningSimulators: 1,
          totalBytes: 8_000_000_000,
        }}
      />,
    );

    expect(html).toContain("1/3 sims");
    expect(html).not.toContain("1/3 devices");
  });
});
