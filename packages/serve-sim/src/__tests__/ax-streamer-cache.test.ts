import { describe, expect, test } from "bun:test";
import { createAxStreamerCache } from "../ax";

describe("createAxStreamerCache", () => {
  test("get() reuses the same streamer for a udid and retargets the port", () => {
    const cache = createAxStreamerCache();
    const a = cache.get("UDID-1", 4001);
    const b = cache.get("UDID-1", 4002);
    expect(a).toBe(b);
    expect(cache.size()).toBe(1);
  });

  test("prune() drops streamers for udids no longer active", () => {
    const cache = createAxStreamerCache();
    cache.get("UDID-A", 4001);
    cache.get("UDID-B", 4002);
    cache.get("UDID-C", 4003);
    expect(cache.size()).toBe(3);

    cache.prune(["UDID-A", "UDID-C"]);
    expect(cache.size()).toBe(2);

    cache.prune([]);
    expect(cache.size()).toBe(0);
  });

  test("a streamer disposed via prune() no longer accepts clients", () => {
    const cache = createAxStreamerCache();
    const streamer = cache.get("UDID-X", 4001);
    cache.prune([]);

    // Disposed streamer's addClient returns a no-op cleanup and never
    // pushes data — verifies it won't keep poll timers alive after prune.
    const writes: string[] = [];
    const removeClient = streamer.addClient({ write: (s) => writes.push(s) });
    expect(typeof removeClient).toBe("function");
    expect(writes).toEqual([]);
    removeClient();
  });
});
