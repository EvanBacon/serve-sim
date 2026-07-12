import { describe, expect, test } from "bun:test";
import { streamConfigFrom } from "../client/utils/sim-endpoint";

// The middleware injects a minimal `{basePath, execToken}` __SIM_PREVIEW__
// when no helper is attached (the empty state needs the exec token before a
// device exists). The client must not treat that as a stream config: doing so
// mounts SimulatorView with url=undefined, which fetches /undefined/stream.avcc
// and — when the api/events correction never arrives — trips the 6s "Stream is
// not producing frames" watchdog on a page that should show the device picker.

const fullConfig = {
  url: "http://127.0.0.1:3100",
  streamUrl: "http://127.0.0.1:3100/stream.mjpeg",
  wsUrl: "ws://127.0.0.1:3100/ws",
  pid: 123,
  port: 3100,
  device: "ABCD-1234",
  basePath: "",
  execToken: "tok",
};

describe("streamConfigFrom", () => {
  test("accepts a full helper state", () => {
    expect(streamConfigFrom(fullConfig)).toBe(fullConfig);
  });

  test("rejects the minimal empty-state injection", () => {
    expect(
      streamConfigFrom({ basePath: "", execToken: "tok" } as never),
    ).toBeNull();
  });

  test("rejects null and undefined", () => {
    expect(streamConfigFrom(null)).toBeNull();
    expect(streamConfigFrom(undefined)).toBeNull();
  });

  test("rejects a config missing the stream url", () => {
    expect(
      streamConfigFrom({ ...fullConfig, url: undefined } as never),
    ).toBeNull();
  });
});
