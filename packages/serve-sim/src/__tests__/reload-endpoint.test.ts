import { describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "http";
import type { AddressInfo } from "net";
import { METRO_RELOAD_SERVER_BUDGET_MS, reloadViaMetro } from "../metro-reload";
import { simMiddleware, simulatorName } from "../middleware";

async function postReload(
  body: string,
  path = "/reload?device=SERVE-SIM-TEST-DEVICE",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const middleware = simMiddleware({ basePath: "/", proxyHelpers: true });
  const server = createHttpServer((req, res) => {
    void middleware(req, res, async () => {
      res.writeHead(404);
      res.end("Not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("POST /reload", () => {
  test("rejects requests without a device instead of picking the first simulator", async () => {
    expect(await postReload(JSON.stringify({ bundleId: "com.example.app" }), "/reload")).toEqual({
      status: 400,
      json: { sent: false, error: "Missing device" },
    });
  });

  test("Expo Go is reported as not sent before any device lookup", async () => {
    expect(await postReload(JSON.stringify({ bundleId: "host.exp.Exponent" }))).toEqual({
      status: 200,
      json: { sent: false, reason: "unsupported-app", confirmed: false },
    });
  });

  test("a missing bundle id sends nothing", async () => {
    const { status, json } = await postReload("{}");
    expect(status).toBe(200);
    expect(json.sent).toBe(false);
  });

  test("answers with sent:false within the server budget when no Metro serves the app", async () => {
    const started = Date.now();
    const { status, json } = await postReload(JSON.stringify({ bundleId: "com.serve-sim.test.no-such-app" }));
    expect(Date.now() - started).toBeLessThan(METRO_RELOAD_SERVER_BUDGET_MS + 300);
    expect(status).toBe(200);
    expect(json.sent).toBe(false);
  });

  test("bodies over 4 KB are rejected with 413 and send nothing", async () => {
    const body = JSON.stringify({ bundleId: "com.example.app", pad: "x".repeat(8 * 1024) });
    expect(await postReload(body)).toEqual({
      status: 413,
      json: { sent: false, error: "Body too large" },
    });
  });

  test("the 4 KB cap counts bytes, so multibyte bodies under 4K characters still get 413", async () => {
    const body = JSON.stringify({ bundleId: "com.example.app", pad: "é".repeat(3 * 1024) });
    expect(body.length).toBeLessThan(4 * 1024);
    expect(Buffer.byteLength(body)).toBeGreaterThan(4 * 1024);
    expect(await postReload(body)).toEqual({
      status: 413,
      json: { sent: false, error: "Body too large" },
    });
  });

  test("malformed bodies send nothing", async () => {
    const { status, json } = await postReload("{");
    expect(status).toBe(400);
    expect(json.sent).toBe(false);
  });
});

describe("simulatorName", () => {
  const SIM = "iPhone 17 Pro";
  const sim = (udid: string, state = "Booted") => ({ udid, name: SIM, state });

  test("lists afresh on every call, so a twin booted since the last call is seen", async () => {
    let sims = [sim("a"), sim("b", "Shutdown")];
    const list = async () => sims;
    expect(await simulatorName("a", list)).toBe(SIM);
    sims = [sim("a"), sim("b")];
    expect(await simulatorName("a", list)).toBeUndefined();
  });

  test("a failed listing gives no name instead of a stale one", async () => {
    expect(await simulatorName("a", async () => [sim("a")])).toBe(SIM);
    expect(await simulatorName("a", async () => [])).toBeUndefined();
  });

  test("a listing that outlasts the lookup budget sends no reload", async () => {
    const sent: number[] = [];
    let finishListing!: () => void;
    const listing = new Promise<void>((resolve) => (finishListing = resolve));
    const slowList = async () => {
      await listing;
      return [sim("a")];
    };
    const result = await reloadViaMetro("com.example.devclient", simulatorName("a", slowList), [8083], {
      fetchJson: async () => [{ appId: "com.example.devclient", deviceName: SIM, reactNative: { logicalDeviceId: SIM } }],
      sendReload: async (port) => {
        sent.push(port);
        return "targeted";
      },
      lookupBudgetMs: 20,
    });
    expect(result).toEqual({ sent: false, reason: "timeout" });
    finishListing();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([]);
  });
});
