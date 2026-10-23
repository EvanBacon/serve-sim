import { afterEach, describe, expect, test } from "bun:test";
import { WebSocketServer, type WebSocket } from "ws";
import { METRO_RELOAD_TIMEOUT_MS } from "../client/utils/metro-reload-request";
import {
  METRO_RELOAD_SERVER_BUDGET_MS,
  appPeerIds,
  metroServesApp,
  metroServesOnlyDevice,
  reloadViaMetro,
  sendMetroReload,
  supportsMetroReload,
  type MetroSendOutcome,
} from "../metro-reload";

const EXPO_GO = "host.exp.Exponent";
const DEV_CLIENT = "com.example.devclient";
const SIM = "iPhone 17 Pro";

const target = (appId: string, deviceName: string, logicalDeviceId = deviceName) => ({
  appId,
  deviceName,
  reactNative: { logicalDeviceId },
});

describe("metroServesApp", () => {
  test("matches the app on this simulator", () => {
    expect(metroServesApp([target(DEV_CLIENT, SIM)], DEV_CLIENT, SIM)).toBe(true);
  });

  test("skips the same app served to another device", () => {
    expect(metroServesApp([target(DEV_CLIENT, "iPhone 16e")], DEV_CLIENT, SIM)).toBe(false);
  });

  test("requires the device name to match", () => {
    expect(metroServesApp([{ appId: DEV_CLIENT }], DEV_CLIENT, SIM)).toBe(false);
  });

  test("ignores other apps and empty target lists", () => {
    expect(metroServesApp([target("com.example.other", SIM)], DEV_CLIENT, SIM)).toBe(false);
    expect(metroServesApp([], DEV_CLIENT, SIM)).toBe(false);
  });
});

describe("metroServesOnlyDevice", () => {
  test("true when this simulator is the only connected device", () => {
    expect(metroServesOnlyDevice([target(DEV_CLIENT, SIM), target(DEV_CLIENT, SIM)], DEV_CLIENT, SIM)).toBe(true);
  });

  test("false when another device shares the Metro", () => {
    expect(metroServesOnlyDevice([target(DEV_CLIENT, SIM), target(DEV_CLIENT, "Pixel 9")], DEV_CLIENT, SIM)).toBe(false);
  });

  test("false when another simulator has the same name", () => {
    expect(
      metroServesOnlyDevice([target(DEV_CLIENT, SIM, "a"), target(DEV_CLIENT, SIM, "b")], DEV_CLIENT, SIM),
    ).toBe(false);
  });

  test("false when the app isn't served here", () => {
    expect(metroServesOnlyDevice([target(DEV_CLIENT, "Pixel 9")], DEV_CLIENT, SIM)).toBe(false);
  });
});

describe("appPeerIds", () => {
  test("keeps app sockets (with a role) and drops tools", () => {
    expect(appPeerIds({ "1": "role=ios", "2": {}, "3": "", "4": "role=android&x=1" })).toEqual(["1", "4"]);
  });

  test("handles junk", () => {
    expect(appPeerIds(null)).toEqual([]);
    expect(appPeerIds("nope")).toEqual([]);
  });
});

describe("reloadViaMetro", () => {
  const lists: Record<number, unknown> = {
    8081: [],
    8082: [target(DEV_CLIENT, "iPhone 16e")],
    8083: [target(DEV_CLIENT, SIM)],
    8084: "Upgrade Required",
    8085: [target(EXPO_GO, SIM)],
    8086: [target(DEV_CLIENT, SIM), target(DEV_CLIENT, "Pixel 9")],
    8087: [target(DEV_CLIENT, SIM)],
  };
  const fetchJson = async (url: string) => {
    const port = Number(new URL(url).port);
    if (!(port in lists)) throw new Error("ECONNREFUSED");
    return lists[port];
  };
  const recordSends = (outcome: MetroSendOutcome = "targeted") => {
    const sent: number[] = [];
    const sendReload = async (port: number) => {
      sent.push(port);
      return outcome;
    };
    return { sent, sendReload };
  };

  test("reloads through the Metro serving only this simulator", async () => {
    const { sent, sendReload } = recordSends();
    expect(await reloadViaMetro(DEV_CLIENT, SIM, [8081, 8082, 8083, 8084, 8090], { fetchJson, sendReload })).toEqual({
      sent: true,
      port: 8083,
      targeted: true,
    });
    expect(sent).toEqual([8083]);
  });

  test("reports a broadcast as sent but untargeted", async () => {
    const { sendReload } = recordSends("broadcast");
    expect(await reloadViaMetro(DEV_CLIENT, SIM, [8083], { fetchJson, sendReload })).toEqual({
      sent: true,
      port: 8083,
      targeted: false,
    });
  });

  test("nothing sent when no Metro serves the app here", async () => {
    const { sent, sendReload } = recordSends();
    expect(await reloadViaMetro(DEV_CLIENT, SIM, [8081, 8082, 8090], { fetchJson, sendReload })).toEqual({
      sent: false,
      reason: "no-metro",
    });
    expect(sent).toEqual([]);
  });

  test("nothing sent when another device shares the Metro", async () => {
    const { sent, sendReload } = recordSends();
    expect(await reloadViaMetro(DEV_CLIENT, SIM, [8086], { fetchJson, sendReload })).toMatchObject({
      sent: false,
      reason: "ambiguous",
    });
    expect(sent).toEqual([]);
  });

  test("nothing sent when several Metros serve the app here", async () => {
    const { sent, sendReload } = recordSends();
    expect(await reloadViaMetro(DEV_CLIENT, SIM, [8083, 8087], { fetchJson, sendReload })).toEqual({
      sent: false,
      reason: "ambiguous",
      ports: [8083, 8087],
    });
    expect(sent).toEqual([]);
  });

  test("nothing sent when the simulator name is unknown", async () => {
    const { sent, sendReload } = recordSends();
    expect(await reloadViaMetro(DEV_CLIENT, null, [8083], { fetchJson, sendReload })).toEqual({
      sent: false,
      reason: "unknown-device",
    });
    expect(sent).toEqual([]);
  });

  test("passes on send failures and several connected apps", async () => {
    expect(await reloadViaMetro(DEV_CLIENT, SIM, [8083], { fetchJson, sendReload: recordSends("failed").sendReload }))
      .toMatchObject({ sent: false, reason: "send-failed" });
    expect(await reloadViaMetro(DEV_CLIENT, SIM, [8083], { fetchJson, sendReload: recordSends("ambiguous").sendReload }))
      .toMatchObject({ sent: false, reason: "ambiguous" });
  });

  test("resolves a pending device name alongside the Metro probes", async () => {
    const { sent, sendReload } = recordSends();
    let probedBeforeName = false;
    let nameResolved = false;
    const name = new Promise<string>((resolve) => setTimeout(() => { nameResolved = true; resolve(SIM); }, 30));
    const result = await reloadViaMetro(DEV_CLIENT, name, [8083], {
      fetchJson: async (url) => { probedBeforeName = !nameResolved; return fetchJson(url); },
      sendReload,
    });
    expect(result).toEqual({ sent: true, port: 8083, targeted: true });
    expect(probedBeforeName).toBe(true);
    expect(sent).toEqual([8083]);
  });

  test("nothing sent when the device lookup outlasts the budget", async () => {
    const { sent, sendReload } = recordSends();
    const slowName = new Promise<string>((resolve) => setTimeout(() => resolve(SIM), 200));
    const started = Date.now();
    expect(await reloadViaMetro(DEV_CLIENT, slowName, [8083], { fetchJson, sendReload, lookupBudgetMs: 20 }))
      .toEqual({ sent: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(150);
    // A late name must not trigger a send.
    await slowName;
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([]);
  });

  test("nothing sent when the device lookup fails", async () => {
    const { sent, sendReload } = recordSends();
    expect(await reloadViaMetro(DEV_CLIENT, Promise.reject(new Error("simctl")), [8083], { fetchJson, sendReload }))
      .toEqual({ sent: false, reason: "unknown-device" });
    expect(sent).toEqual([]);
  });

  test("the server always answers before the browser gives up", () => {
    // The client only taps R on an explicit `sent: false`; it must get one.
    expect(METRO_RELOAD_SERVER_BUDGET_MS + 500).toBeLessThanOrEqual(METRO_RELOAD_TIMEOUT_MS);
  });

  test("skips Expo Go, which ignores the reload, without probing", async () => {
    let probed = false;
    const { sent, sendReload } = recordSends();
    expect(supportsMetroReload(EXPO_GO)).toBe(false);
    expect(
      await reloadViaMetro(EXPO_GO, SIM, [8085], {
        fetchJson: async (url) => { probed = true; return fetchJson(url); },
        sendReload,
      }),
    ).toEqual({ sent: false, reason: "unsupported-app" });
    expect(probed).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("sendMetroReload", () => {
  let server: WebSocketServer | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  /**
   * A fake Metro `/message` server; `peers` answers getpeers (null = ignore
   * it, "error" = reply with an error like the community CLI does).
   */
  async function fakeMetro(peers: Record<string, unknown> | null | "error") {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => server!.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    const frames: unknown[] = [];
    let info: { path?: string; origin?: string } = {};
    server.on("connection", (socket: WebSocket, req) => {
      info = { path: req.url, origin: req.headers.origin };
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        frames.push(msg);
        if (msg.method === "getpeers" && peers === "error") {
          socket.send(JSON.stringify({ id: msg.id, error: "Cannot read properties of undefined (reading 'url')" }));
        } else if (msg.method === "getpeers" && peers) {
          socket.send(JSON.stringify({ id: msg.id, result: peers }));
        }
      });
    });
    return { port, frames, info: () => info };
  }

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  test("targets the only connected app", async () => {
    const metro = await fakeMetro({ "7": "role=ios", "8": {} });
    expect(await sendMetroReload(metro.port)).toBe("targeted");
    await waitFor(() => metro.frames.length >= 2);
    expect(metro.info().path).toBe("/message");
    // Expo CLI only trusts clients without a browser Origin.
    expect(metro.info().origin).toBeUndefined();
    expect(metro.frames[0]).toMatchObject({ version: 2, method: "getpeers", target: "server" });
    expect(metro.frames[1]).toEqual({ version: 2, method: "reload", target: "7" });
  });

  test("sends nothing when several apps are connected", async () => {
    const metro = await fakeMetro({ "7": "role=ios", "9": "role=ios" });
    expect(await sendMetroReload(metro.port)).toBe("ambiguous");
    await new Promise((r) => setTimeout(r, 30));
    expect(metro.frames).toHaveLength(1);
  });

  test("sends nothing when no app is connected", async () => {
    const metro = await fakeMetro({});
    expect(await sendMetroReload(metro.port)).toBe("failed");
  });

  test("broadcasts when Metro doesn't answer getpeers", async () => {
    const metro = await fakeMetro(null);
    expect(await sendMetroReload(metro.port, { peersTimeoutMs: 20 })).toBe("broadcast");
    await waitFor(() => metro.frames.length >= 2);
    expect(metro.frames[1]).toEqual({ version: 2, method: "reload" });
  });

  test("broadcasts right away when getpeers answers with an error", async () => {
    const metro = await fakeMetro("error");
    const started = Date.now();
    expect(await sendMetroReload(metro.port, { peersTimeoutMs: 1000 })).toBe("broadcast");
    expect(Date.now() - started).toBeLessThan(500);
    await waitFor(() => metro.frames.length >= 2);
    expect(metro.frames[1]).toEqual({ version: 2, method: "reload" });
  });

  test("fails when nothing is listening", async () => {
    const probe = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => probe.once("listening", () => r()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    expect(await sendMetroReload(port)).toBe("failed");
  });
});
