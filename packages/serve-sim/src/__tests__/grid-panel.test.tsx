import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GridCapacityFooter, GridPanel } from "../client/components/grid-panel";
import type { GridDevice, MemoryReport } from "../client/utils/grid";

const devices: GridDevice[] = [
  {
    device: "one",
    name: "iPhone 16",
    runtime: "iOS-26-5",
    state: "Booted",
    helper: null,
  },
];

const noop = () => {};

const memoryReport: MemoryReport = {
  totalBytes: 100,
  availableBytes: 20,
  runningSimulators: 3,
  perSimAvgBytes: 10,
  perSimSource: "estimated",
  estimatedAdditional: 5,
};

describe("GridPanel", () => {
  test("renders row-shaped skeletons while devices are loading", () => {
    const html = renderToStaticMarkup(
      <GridPanel
        open
        onClose={noop}
        width={320}
        side="left"
        devices={null}
        selectedUdid={null}
        onSelect={noop}
        starting={{}}
        shuttingDown={{}}
        onShutdown={noop}
      />,
    );

    expect(html).toContain('data-testid="device-list-skeleton"');
    expect(html).toContain('data-testid="device-row-skeleton"');
    expect(html).toContain("Available");
    expect(html).not.toContain("No iOS simulators available.");
  });

  test("aligns the close control to the closed sidebar opener", () => {
    const html = renderToStaticMarkup(
      <GridPanel
        open
        onClose={noop}
        width={320}
        side="left"
        devices={devices}
        selectedUdid="one"
        onSelect={noop}
        starting={{}}
        shuttingDown={{}}
        onShutdown={noop}
      />,
    );

    expect(html).toContain("padding-left:16px");
    expect(html).toContain("padding-top:16px");
  });

  test("renders gradient fades around the device list scroll area", () => {
    const html = renderToStaticMarkup(
      <GridPanel
        open
        onClose={noop}
        width={320}
        side="left"
        devices={devices}
        selectedUdid="one"
        onSelect={noop}
        starting={{}}
        shuttingDown={{}}
        onShutdown={noop}
      />,
    );

    expect(html).toContain('data-testid="device-list-top-fade"');
    expect(html).toContain('data-testid="device-list-bottom-fade"');
    expect(html).toContain("linear-gradient(to_bottom");
    expect(html).toContain("linear-gradient(to_top");
  });

  test("renders the capacity footer without a top border", () => {
    const html = renderToStaticMarkup(<GridCapacityFooter report={memoryReport} />);

    expect(html).toContain("3/8 sims");
    expect(html).not.toContain("border-t");
  });

  test("line-clamps capacity footer content to one row", () => {
    const html = renderToStaticMarkup(<GridCapacityFooter report={memoryReport} />);

    expect(html).toContain("min-w-0 overflow-hidden");
    expect(html).toContain("max-w-full min-w-0 flex-nowrap");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("truncate");
    expect(html).toContain("w-7 h-[3px] shrink-0");
  });
});
