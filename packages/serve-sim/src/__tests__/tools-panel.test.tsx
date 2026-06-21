import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolsPanel } from "../client/components/tools-panel";

const noop = () => {};

describe("ToolsPanel", () => {
  test("uses the shared panel background variable", () => {
    const html = renderToStaticMarkup(
      <ToolsPanel
        open={false}
        onClose={noop}
        udid="one"
        deviceRuntime="iOS-27-0"
        currentApp={null}
        axOverlayEnabled={false}
        onToggleAxOverlay={noop}
        codecPreference="auto"
        onCodecPreferenceChange={noop}
        activeCodec="h264"
        avccSupported
        width={320}
      />,
    );

    expect(html).toContain("background-color:var(--serve-sim-panel-bg)");
  });
});
