import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceRow } from "../client/components/device-row";
import type { GridDevice } from "../client/utils/grid";

const noop = () => {};

function render(device: GridDevice, active = false): string {
  return renderToStaticMarkup(
    <DeviceRow
      device={device}
      active={active}
      starting={false}
      shuttingDown={false}
      onSelect={noop}
      onShutdown={noop}
    />,
  );
}

describe("DeviceRow", () => {
  test("does not render a redundant Simulator status for idle devices", () => {
    const html = render({
      device: "idle",
      name: "iPhone 17",
      runtime: "iOS-27-0",
      state: "Shutdown",
      helper: null,
    });

    expect(html).toContain("iPhone 17");
    expect(html).not.toContain("Simulator");
  });

  test("keeps meaningful streaming status", () => {
    const html = render({
      device: "streaming",
      name: "iPhone 16",
      runtime: "iOS-26-5",
      state: "Booted",
      helper: {
        port: 3100,
        url: "http://localhost:3100",
        streamUrl: "http://localhost:3100/stream.mjpeg",
        wsUrl: "ws://localhost:3100/ws",
      },
    });

    expect(html).toContain("Streaming");
  });

  test("does not render a live stream thumbnail in the device list", () => {
    const html = render({
      device: "streaming",
      name: "iPhone 16",
      runtime: "iOS-26-5",
      state: "Booted",
      helper: {
        port: 3100,
        url: "http://localhost:3100",
        streamUrl: "http://localhost:3100/stream.mjpeg",
        wsUrl: "ws://localhost:3100/ws",
      },
    });

    expect(html).not.toContain("<img");
    expect(html).not.toContain("stream.mjpeg");
  });

  test("keeps streaming status green when selected", () => {
    const html = render(
      {
        device: "streaming",
        name: "iPhone 16",
        runtime: "iOS-26-5",
        state: "Booted",
        helper: {
          port: 3100,
          url: "http://localhost:3100",
          streamUrl: "http://localhost:3100/stream.mjpeg",
          wsUrl: "ws://localhost:3100/ws",
        },
      },
      true,
    );

    expect(html).toContain("Streaming");
    expect(html).toContain("text-[#34d399]");
  });

  test("keeps the runtime and shutdown button in a stable trailing slot", () => {
    const html = render({
      device: "streaming",
      name: "iPhone 16",
      runtime: "iOS-26-5",
      state: "Booted",
      helper: {
        port: 3100,
        url: "http://localhost:3100",
        streamUrl: "http://localhost:3100/stream.mjpeg",
        wsUrl: "ws://localhost:3100/ws",
      },
    });

    expect(html).toContain('data-testid="device-row-trailing-slot"');
    expect(html).toContain("w-8 h-6");
    expect(html).toContain("group-hover:opacity-0");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).not.toContain("group-hover:hidden");
  });

  test("uses a light overlay instead of a bright blue selected state", () => {
    const html = render(
      {
        device: "streaming",
        name: "iPhone 16",
        runtime: "iOS-26-5",
        state: "Booted",
        helper: {
          port: 3100,
          url: "http://localhost:3100",
          streamUrl: "http://localhost:3100/stream.mjpeg",
          wsUrl: "ws://localhost:3100/ws",
        },
      },
      true,
    );

    expect(html).toContain("bg-white/10");
    expect(html).not.toContain("bg-[#0a84ff]");
    expect(html).not.toContain("shadow-[inset");
  });
});
