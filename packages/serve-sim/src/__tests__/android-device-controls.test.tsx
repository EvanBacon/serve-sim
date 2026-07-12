import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulatorToolbar } from "../client/simulator";
import { AndroidDeviceControls } from "../client/components/android-device-controls";

describe("AndroidDeviceControls", () => {
  test("renders Android emulator-style hardware and navigation buttons", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar
        exec={async () => ({ stdout: "", stderr: "", exitCode: 0 })}
        deviceUdid="emulator-5554"
        deviceName="Pixel 8"
        deviceRuntime="Android"
        streaming
      >
        <SimulatorToolbar.Actions>
          <AndroidDeviceControls onButton={() => {}} />
        </SimulatorToolbar.Actions>
      </SimulatorToolbar>,
    );

    expect(html).toContain('aria-label="Android Back"');
    expect(html).toContain('aria-label="Android Home"');
    expect(html).toContain('aria-label="Android Recents"');
    expect(html).toContain('aria-label="Android Volume Down"');
    expect(html).toContain('aria-label="Android Volume Up"');
    expect(html).toContain('aria-label="Android Power"');
  });
});
