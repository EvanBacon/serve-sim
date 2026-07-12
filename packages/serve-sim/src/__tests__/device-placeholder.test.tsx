import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DevicePlaceholder } from "../client/components/device-placeholder";
import type {
  DeviceKitChromeDescriptor,
  DevicePlaceholderAssetDescriptor,
} from "../client/utils/grid";

function renderPlaceholder({
  name = "Apple Vision Pro",
  runtime = "xrOS-26-5",
  chrome = null,
  placeholderAsset = null,
}: {
  name?: string;
  runtime?: string;
  chrome?: DeviceKitChromeDescriptor | null;
  placeholderAsset?: DevicePlaceholderAssetDescriptor | null;
} = {}) {
  return renderToStaticMarkup(
    <DevicePlaceholder
      name={name}
      runtime={runtime}
      chrome={chrome}
      placeholderAsset={placeholderAsset}
      busy={false}
      error={null}
      onStart={() => {}}
    />,
  );
}

describe("DevicePlaceholder", () => {
  test("uses a headset-shaped Vision fallback instead of the generic blue screen", () => {
    const html = renderPlaceholder({
      placeholderAsset: {
        name: "com.apple.vision-pro",
        width: 1023,
        height: 524,
      },
    });

    expect(html).toContain("grid/api/device-placeholder-asset?name=com.apple.vision-pro");
    expect(html).toContain("vision-placeholder-shell");
    expect(html).not.toContain("placeholder-screen");
  });

  test("uses Apple preview assets for current device placeholders", () => {
    const chrome = {
      identifier: "watch6",
      frame: { width: 120, height: 140 },
      body: { x: 10, y: 10, width: 100, height: 120 },
      screen: { x: 20, y: 20, width: 80, height: 100 },
      insets: { top: 10, left: 10, bottom: 10, right: 10 },
      outerCornerRadius: 16,
      innerCornerRadius: 12,
      screenRadius: 10,
      compositeImage: "WatchComposite",
      slice: null,
      corner: null,
      buttons: [],
    } satisfies DeviceKitChromeDescriptor;

    const cases = [
      ["Apple Watch Series 11 (42mm)", "watchOS-27-0", "com.apple.apple-watch-series-11-4", 492, 792, 250],
      ["Apple Watch Ultra 3 (49mm)", "watchOS-27-0", "com.apple.apple-watch-ultra-3-8", 499, 795, 255],
      ["Apple Watch SE 3 (40mm)", "watchOS-27-0", "com.apple.apple-watch-se-3-1", 468, 792, 238],
      ["iPhone 17 Pro", "iOS-26-5", "com.apple.iphone-17-pro-2", 950, 1024, 280],
      ["iPad Pro 11-inch (M5)", "iOS-26-5", "com.apple.ipad-pro-11-inch-m5-1", 895, 986, 340],
    ] as const;

    for (const [name, runtime, assetName, width, height, maxWidth] of cases) {
      const html = renderPlaceholder({
        name,
        runtime,
        chrome,
        placeholderAsset: { name: assetName, width, height },
      });
      expect(html).toContain(`grid/api/device-placeholder-asset?name=${assetName}`);
      expect(html).toContain(`width:min(100%, ${maxWidth}px,`);
      expect(html).toContain(`max-width:${maxWidth}px`);
      expect(html).not.toContain("WatchComposite");
    }
  });

  test("draws all hardware buttons for composite DeviceKit chrome", () => {
    const chrome = {
      identifier: "phone11",
      frame: { width: 120, height: 140 },
      body: { x: 10, y: 10, width: 100, height: 120 },
      screen: { x: 20, y: 20, width: 80, height: 100 },
      insets: { top: 10, left: 10, bottom: 10, right: 10 },
      outerCornerRadius: 16,
      innerCornerRadius: 12,
      screenRadius: 10,
      compositeImage: "WatchComposite",
      slice: null,
      corner: null,
      buttons: [
        {
          name: "side-button",
          image: "SideButton",
          imageDown: "SideButton Dn",
          onTop: false,
          frame: { x: 110, y: 30, width: 8, height: 20 },
          hover: { x: 0.1, y: 0 },
          usagePage: 12,
          usage: 149,
        },
        {
          name: "left-side-button",
          image: "StingButton",
          imageDown: "StingButton Dn",
          onTop: true,
          frame: { x: 2, y: 44, width: 4, height: 24 },
          hover: { x: -0.1, y: 0 },
          usagePage: 65281,
          usage: 512,
        },
      ],
    } satisfies DeviceKitChromeDescriptor;

    const html = renderPlaceholder({
      name: "iPhone 17 Pro",
      runtime: "iOS-26-5",
      chrome,
    });

    // The composite pictures only the bezel; every hardware button is drawn as a
    // separate sprite (onTop above the bezel, the rest poking out behind it).
    expect(html).toContain("WatchComposite");
    expect(html).toContain("StingButton");
    expect(html).toContain("SideButton");
  });
});
