import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DevicePlaceholder } from "../client/components/device-placeholder";
import type { DeviceKitChromeDescriptor } from "../client/utils/grid";

function renderPlaceholder({
  name = "Apple Vision Pro",
  runtime = "xrOS-26-5",
  chrome = null,
}: {
  name?: string;
  runtime?: string;
  chrome?: DeviceKitChromeDescriptor | null;
} = {}) {
  return renderToStaticMarkup(
    <DevicePlaceholder
      name={name}
      runtime={runtime}
      chrome={chrome}
      busy={false}
      error={null}
      onStart={() => {}}
    />,
  );
}

describe("DevicePlaceholder", () => {
  test("uses a headset-shaped Vision fallback instead of the generic blue screen", () => {
    const html = renderPlaceholder();

    expect(html).toContain("grid/api/device-placeholder-asset?name=vision-pro");
    expect(html).toContain("vision-placeholder-shell");
    expect(html).not.toContain("placeholder-screen");
  });

  test("uses Apple preview assets for current watch placeholders", () => {
    const chrome = {
      identifier: "watch6",
      frame: { width: 120, height: 140 },
      body: { x: 10, y: 10, width: 100, height: 120 },
      screen: { x: 20, y: 20, width: 80, height: 100 },
      insets: { top: 10, left: 10, bottom: 10, right: 10 },
      outerCornerRadius: 16,
      innerCornerRadius: 12,
      compositeImage: "WatchComposite",
      slice: null,
      corner: null,
      buttons: [],
    } satisfies DeviceKitChromeDescriptor;

    const cases = [
      ["Apple Watch Series 11 (42mm)", "apple-watch-series-11"],
      ["Apple Watch Ultra 3 (49mm)", "apple-watch-ultra-3"],
      ["Apple Watch SE 3 (40mm)", "apple-watch-se-3"],
    ] as const;

    for (const [name, assetName] of cases) {
      const html = renderPlaceholder({ name, runtime: "watchOS-27-0", chrome });
      expect(html).toContain(`grid/api/device-placeholder-asset?name=${assetName}`);
      expect(html).not.toContain("WatchComposite");
    }
  });

  test("does not duplicate baked-in buttons for composite DeviceKit chrome", () => {
    const chrome = {
      identifier: "phone11",
      frame: { width: 120, height: 140 },
      body: { x: 10, y: 10, width: 100, height: 120 },
      screen: { x: 20, y: 20, width: 80, height: 100 },
      insets: { top: 10, left: 10, bottom: 10, right: 10 },
      outerCornerRadius: 16,
      innerCornerRadius: 12,
      compositeImage: "WatchComposite",
      slice: null,
      corner: null,
      buttons: [
        {
          name: "digital-crown",
          image: "DigitalCrown",
          onTop: false,
          frame: { x: 110, y: 30, width: 8, height: 20 },
        },
        {
          name: "left-side-button",
          image: "StingButton",
          onTop: true,
          frame: { x: 2, y: 44, width: 4, height: 24 },
        },
      ],
    } satisfies DeviceKitChromeDescriptor;

    const html = renderPlaceholder({
      name: "iPhone 17 Pro",
      runtime: "iOS-26-5",
      chrome,
    });

    expect(html).toContain("WatchComposite");
    expect(html).toContain("StingButton");
    expect(html).not.toContain("DigitalCrown");
  });
});
