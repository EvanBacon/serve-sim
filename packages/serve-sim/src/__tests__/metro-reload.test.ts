import { afterEach, describe, expect, test } from "bun:test";
import { WebSocketServer } from "ws";
import {
  broadcastMetroMessage,
  findMetroPortsForApp,
  metroServesApp,
  reloadViaMetro,
} from "../metro-reload";

const EXPO_GO = "host.exp.Exponent";
const DEV_CLIENT = "com.example.devclient";

describe("metroServesApp", () => {
  test("matches the app on this simulator", () => {
    expect(metroServesApp([{ appId: EXPO_GO, deviceName: "iPhone 17 Pro" }], EXPO_GO, "iPhone 17 Pro")).toBe(true);
  });

  test("skips the same app served to another device", () => {
    expect(metroServesApp([{ appId: EXPO_GO, deviceName: "iPhone 16e" }], EXPO_GO, "iPhone 17 Pro")).toBe(false);
  });

  test("falls back to the app id when either device name is unknown", () => {
    expect(metroServesApp([{ appId: EXPO_GO }], EXPO_GO, "iPhone 17 Pro")).toBe(true);
    expect(metroServesApp([{ appId: EXPO_GO, deviceName: "iPhone 16e" }], EXPO_GO, null)).toBe(true);
  });

  test("ignores other apps and empty target lists", () => {
    expect(metroServesApp([{ appId: "com.example.other" }], EXPO_GO, null)).toBe(false);
    expect(metroServesApp([], EXPO_GO, null)).toBe(false);
  });
});

describe("findMetroPortsForApp", () => {
  const lists: Record<number, unknown> = {
    8081: [],
    8082: [{ appId: DEV_CLIENT, deviceName: "iPhone 16e" }],
    8083: [{ appId: DEV_CLIENT, deviceName: "iPhone 17 Pro" }],
    8084: "Upgrade Required",
    8085: [{ appId: EXPO_GO, deviceName: "iPhone 17 Pro" }],
  };
  const fetchJson = async (url: string) => {
    const port = Number(new URL(url).port);
    if (!(port in lists)) throw new Error("ECONNREFUSED");
    return lists[port];
  };
  const recordBroadcasts = () => {
    const sent: Array<[number, string]> = [];
    const broadcast = async (port: number, method: string) => {
      sent.push([port, method]);
      return true;
    };
    return { sent, broadcast };
  };

  test("finds the Metro serving the app on this simulator", async () => {
    expect(await findMetroPortsForApp(DEV_CLIENT, "iPhone 17 Pro", [8081, 8082, 8083, 8084, 8090], { fetchJson })).toEqual([8083]);
  });

  test("returns nothing when no Metro serves the app", async () => {
    expect(await findMetroPortsForApp("com.example.app", "iPhone 17 Pro", [8081, 8082, 8090], { fetchJson })).toEqual([]);
  });

  test("reloadViaMetro broadcasts reload only to matching ports", async () => {
    const { sent, broadcast } = recordBroadcasts();
    const ports = await reloadViaMetro(DEV_CLIENT, "iPhone 17 Pro", [8081, 8082, 8083], { fetchJson, broadcast });
    expect(ports).toEqual([8083]);
    expect(sent).toEqual([[8083, "reload"]]);
  });

  test("reloadViaMetro reports failure when the broadcast fails", async () => {
    const ports = await reloadViaMetro(DEV_CLIENT, "iPhone 17 Pro", [8083], {
      fetchJson,
      broadcast: async () => false,
    });
    expect(ports).toEqual([]);
  });

  test("reloadViaMetro skips Expo Go, which ignores the broadcast", async () => {
    const { sent, broadcast } = recordBroadcasts();
    expect(await reloadViaMetro(EXPO_GO, "iPhone 17 Pro", [8085], { fetchJson, broadcast })).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("broadcastMetroMessage", () => {
  let server: WebSocketServer | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  test("sends a protocol v2 broadcast on /message", async () => {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => server!.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    const received = new Promise<{ path?: string; origin?: string; data: string }>((resolve) => {
      server!.on("connection", (socket, req) => {
        socket.on("message", (data) =>
          resolve({ path: req.url, origin: req.headers.origin, data: data.toString() }),
        );
      });
    });
    expect(await broadcastMetroMessage(port, "reload")).toBe(true);
    const msg = await received;
    expect(msg.path).toBe("/message");
    // Expo CLI only trusts broadcasts without a browser Origin.
    expect(msg.origin).toBeUndefined();
    expect(JSON.parse(msg.data)).toEqual({ version: 2, method: "reload" });
  });

  test("resolves false when nothing is listening", async () => {
    const probe = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => probe.once("listening", () => r()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    expect(await broadcastMetroMessage(port, "reload")).toBe(false);
  });
});
