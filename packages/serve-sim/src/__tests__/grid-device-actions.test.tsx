import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GridTile } from "../client/components/grid-tile";
import { canShutdownDevice, canStartDevice, type GridDevice } from "../client/utils/grid";

const baseDevice: GridDevice = {
  device: "emulator-5554",
  platform: "android",
  name: "Pixel 8",
  runtime: "Android",
  state: "Booted",
  helper: null,
};

describe("Android grid actions", () => {
  test("only offers start for booted Android devices or stopped emulators", () => {
    expect(canStartDevice({ platform: "android", state: "Booted", runtime: "Android" })).toBe(true);
    expect(canStartDevice({ platform: "android", state: "Shutdown", runtime: "Android Emulator" })).toBe(true);
    expect(canStartDevice({ platform: "android", state: "Offline", runtime: "Android" })).toBe(false);
    expect(canStartDevice({ platform: "android", state: "Unauthorized", runtime: "Android" })).toBe(false);
    expect(canStartDevice({ platform: "ios", state: "Shutdown", runtime: "iOS-18-0" })).toBe(true);
  });

  test("only exposes shutdown for Android emulators", () => {
    expect(canShutdownDevice("android", "emulator-5554")).toBe(true);
    expect(canShutdownDevice("android", "ZY22")).toBe(false);
    expect(canShutdownDevice("ios", "00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  test("does not render a shutdown button for physical Android devices", () => {
    const html = renderToStaticMarkup(
      <GridTile
        device={{ ...baseDevice, device: "ZY22", name: "Pixel 6" }}
        active={false}
        previewEndpoint="/"
        starting={false}
        shuttingDown={false}
        error={null}
        onStart={() => {}}
        onShutdown={() => {}}
      />,
    );

    expect(html).not.toContain("Shutdown Android emulator");
  });

  test("offers to stop a live physical Android stream without calling it shutdown", () => {
    const html = renderToStaticMarkup(
      <GridTile
        device={{
          ...baseDevice,
          device: "ZY22",
          name: "Pixel 6",
          helper: {
            port: 3300,
            url: "http://127.0.0.1:3300",
            streamUrl: "http://127.0.0.1:3300/stream.mjpeg",
            wsUrl: "ws://127.0.0.1:3300/ws",
          },
        }}
        active={false}
        previewEndpoint="/"
        starting={false}
        shuttingDown={false}
        error={null}
        onStart={() => {}}
        onShutdown={() => {}}
      />,
    );

    expect(html).toContain("Stop Android stream");
    expect(html).not.toContain("Shutdown Android emulator");
  });

  test("renders physical Android devices that are not online as unavailable", () => {
    const html = renderToStaticMarkup(
      <GridTile
        device={{ ...baseDevice, device: "ZY22", name: "Pixel 6", state: "Offline", runtime: "Android" }}
        active={false}
        previewEndpoint="/"
        starting={false}
        shuttingDown={false}
        error={null}
        onStart={() => {}}
        onShutdown={() => {}}
      />,
    );

    expect(html).toContain("Unavailable");
    expect(html).toContain("disabled=");
  });
});
