import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamSettingsTool } from "../client/components/stream-settings-tool";

const noop = () => {};

describe("StreamSettingsTool", () => {
  test("omits the device-frame switch when chrome is unavailable", () => {
    const html = renderToStaticMarkup(
      <StreamSettingsTool
        preference="auto"
        onPreferenceChange={noop}
        activeCodec="h264"
        avccSupported
      />,
    );
    expect(html).not.toContain("Device frame");
  });

  test("shows a checked device-frame switch when chrome is available", () => {
    const html = renderToStaticMarkup(
      <StreamSettingsTool
        preference="auto"
        onPreferenceChange={noop}
        activeCodec="h264"
        avccSupported
        chromeAvailable
        hideChrome={false}
        onHideChromeChange={noop}
      />,
    );
    expect(html).toContain("Device frame");
    expect(html).toContain('aria-checked="true"');
  });

  test("unchecks the device-frame switch when the bezel is hidden", () => {
    const html = renderToStaticMarkup(
      <StreamSettingsTool
        preference="auto"
        onPreferenceChange={noop}
        activeCodec="h264"
        avccSupported
        chromeAvailable
        hideChrome
        onHideChromeChange={noop}
      />,
    );
    expect(html).toContain('aria-checked="false"');
  });
});
