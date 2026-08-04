import { describe, expect, test } from "bun:test";
import type { HostEventStream } from "../client/utils/exec";
import {
  bindSelectedConfigStream,
  fetchSelectedStreamConfig,
  selectedConfigEndpoint,
} from "../client/utils/selected-stream-config";

const config = {
  url: "http://127.0.0.1:3200/helper/DEVICE-A",
  streamUrl: "http://127.0.0.1:3200/helper/DEVICE-A/stream.mjpeg",
  wsUrl: "ws://127.0.0.1:3200/helper/DEVICE-A/ws",
  pid: 123,
  port: 3200,
  device: "DEVICE-A",
  basePath: "",
  execToken: "token",
};

describe("selected stream config recovery", () => {
  test("preserves mount queries when selecting a device", () => {
    expect(selectedConfigEndpoint("/.sim/api?source=grid", "DEVICE A")).toBe(
      "/.sim/api?source=grid&device=DEVICE%20A",
    );
  });

  test("fetches only a config for the requested device without caching", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetched = await fetchSelectedStreamConfig("/.sim/api", "DEVICE-A", {
      fetchImpl: async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response(JSON.stringify(config), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(fetched).toEqual(config);
    expect(requests[0]?.input).toBe("/.sim/api?device=DEVICE-A");
    expect(requests[0]?.init?.cache).toBe("no-store");
  });

  test("rejects a stale config for another selection", async () => {
    const fetched = await fetchSelectedStreamConfig("/api", "DEVICE-B", {
      fetchImpl: async () => new Response(JSON.stringify(config)),
    });
    expect(fetched).toBeNull();
  });

  test("ignores a queued event after the old selection is closed", () => {
    let closed = false;
    const stream: HostEventStream = {
      onmessage: null,
      onerror: null,
      close: () => { closed = true; },
    };
    const applied: Array<typeof config | null> = [];
    const dispose = bindSelectedConfigStream(stream, "DEVICE-A", (next) => {
      applied.push(next as typeof config | null);
    });
    const queuedHandler = stream.onmessage!;

    queuedHandler({ data: JSON.stringify(config) });
    dispose();
    queuedHandler({ data: "null" });

    expect(closed).toBe(true);
    expect(applied).toEqual([config]);
  });
});
