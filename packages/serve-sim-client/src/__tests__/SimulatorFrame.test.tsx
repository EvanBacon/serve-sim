import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulatorFrame } from "../simulator/SimulatorFrame";
import type { StreamAPI } from "../react";
import type { SimulatorOrientation } from "../types";

const exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });

function streamWithConfig(
  width: number,
  height: number,
  orientation?: SimulatorOrientation,
): StreamAPI {
  return {
    start: () => {},
    stop: () => {},
    sendTouch: () => {},
    sendMultiTouch: () => {},
    sendButton: () => {},
    subscribeFrame: () => () => {},
    frame: null,
    config: { width, height, orientation },
    adaptiveFps: 30,
    adaptiveState: "normal",
    connectionQuality: null,
  };
}

describe("SimulatorFrame", () => {
  test("uses live landscape stream dimensions instead of static portrait fallback", () => {
    const html = renderToStaticMarkup(
      createElement(SimulatorFrame, {
        exec,
        deviceName: "iPhone 16 Pro Max",
        showChrome: true,
        stream: streamWithConfig(2868, 1320),
      }),
    );

    expect(html).toContain('data-orientation="landscape"');
    expect(html).toContain("max-width:620px");
    expect(html).toContain("aspect-ratio:2868 / 1320");
    expect(html).not.toContain("chrome-filter0");
  });

  test("uses requested landscape orientation when raw stream dimensions stay portrait", () => {
    const html = renderToStaticMarkup(
      createElement(SimulatorFrame, {
        exec,
        deviceName: "iPhone 16 Pro Max",
        showChrome: true,
        stream: streamWithConfig(1320, 2868, "landscape_left"),
      }),
    );

    expect(html).toContain('data-orientation="landscape"');
    expect(html).toContain("max-width:620px");
    expect(html).toContain("aspect-ratio:2868 / 1320");
    expect(html).not.toContain("chrome-filter0");
  });

  test("keeps portrait chrome for portrait stream dimensions", () => {
    const html = renderToStaticMarkup(
      createElement(SimulatorFrame, {
        exec,
        deviceName: "iPhone 16 Pro Max",
        showChrome: true,
        stream: streamWithConfig(1320, 2868),
      }),
    );

    expect(html).toContain('data-orientation="portrait"');
    expect(html).toContain("max-width:320px");
    expect(html).toContain("aspect-ratio:1320 / 2868");
    expect(html).toContain("chrome-filter0");
  });
});
