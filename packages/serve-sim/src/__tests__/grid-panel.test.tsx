import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GridPanel } from "../client/components/grid-panel";
import type { GridDevice } from "../client/utils/grid";

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

describe("GridPanel", () => {
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
});
