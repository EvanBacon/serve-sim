import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer, type Server } from "http";
import type { AddressInfo, Socket } from "net";
import { simMiddleware, type ServeSimState } from "../middleware";
import { STATE_DIR, stateFileForDevice } from "../state";

// An embedded mount (`app.use(simMiddleware({ basePath: "/.sim" }))` in a dev
// server) is a different origin than the serve-sim helper, and the helper no
// longer sends wildcard CORS. Its page must get same-origin helper URLs routed
// through the mount's own `/.sim/helper` proxy, not the helper's port.

delete process.env.SERVE_SIM_AUTH_TOKEN;
(globalThis as Record<string, unknown>).__PREVIEW_HTML_B64__ = Buffer.from(
  "<!doctype html><html><head><!--__SIM_PREVIEW_CONFIG__--></head></html>",
).toString("base64");

// Not a simulator UDID, so the state survives the booted-device check.
const DEVICE = `EMBEDDED-PREVIEW-${process.pid}`;
const HELPER_PORT = 3100;
const stateFile = stateFileForDevice(DEVICE);

function listen(options: Parameters<typeof simMiddleware>[0]): Promise<{ server: Server; origin: string }> {
  const middleware = simMiddleware(options);
  const server = createServer((req, res) => {
    middleware(req, res, async () => {
      if (!res.headersSent) res.statusCode = 404;
      res.end("host-app");
    });
  });
  server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket as Socket, head));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function pageConfig(origin: string): Promise<Record<string, unknown>> {
  const html = await (await fetch(`${origin}/.sim?device=${DEVICE}`)).text();
  const json = /window\.__SIM_PREVIEW__=(\{.*?\})<\/script>/.exec(html)?.[1];
  if (!json) throw new Error(`no preview config in page: ${html.slice(0, 200)}`);
  return JSON.parse(json);
}

let byDefault: { server: Server; origin: string };
let direct: { server: Server; origin: string };

beforeAll(async () => {
  mkdirSync(STATE_DIR, { recursive: true });
  const state: ServeSimState = {
    pid: process.pid,
    port: HELPER_PORT,
    device: DEVICE,
    url: `http://127.0.0.1:${HELPER_PORT}`,
    streamUrl: `http://127.0.0.1:${HELPER_PORT}/helper/${DEVICE}/stream.mjpeg`,
    wsUrl: `ws://127.0.0.1:${HELPER_PORT}/helper/${DEVICE}/ws`,
  };
  writeFileSync(stateFile, JSON.stringify(state));
  byDefault = await listen({ basePath: "/.sim", device: DEVICE });
  direct = await listen({ basePath: "/.sim", device: DEVICE, proxyHelpers: false });
});

afterAll(async () => {
  rmSync(stateFile, { force: true });
  await Promise.all([close(byDefault.server), close(direct.server)]);
});

describe("embedded simMiddleware({ basePath: '/.sim' })", () => {
  test("hands the page same-origin helper URLs by default", async () => {
    const config = await pageConfig(byDefault.origin);
    const devicePath = `/.sim/helper/${DEVICE}`;
    const wsOrigin = byDefault.origin.replace(/^http/, "ws");
    expect(config.proxyHelpers).toBe(true);
    expect(config.url).toBe(`${byDefault.origin}${devicePath}`);
    expect(config.streamUrl).toBe(`${byDefault.origin}${devicePath}/stream.mjpeg`);
    expect(config.wsUrl).toBe(`${wsOrigin}${devicePath}/ws`);
    for (const key of ["url", "streamUrl", "wsUrl"]) {
      expect(String(config[key])).not.toContain(`:${HELPER_PORT}`);
    }
  });

  test("helper responses carry no wildcard CORS", async () => {
    const res = await fetch(`${byDefault.origin}/.sim/helper/${DEVICE}/config`, {
      headers: { Origin: "http://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    await res.body?.cancel();
  });

  test("proxyHelpers: false opts back in to the helper's direct URLs", async () => {
    const config = await pageConfig(direct.origin);
    expect(config.proxyHelpers).toBeUndefined();
    expect(config.url).toBe(`http://127.0.0.1:${HELPER_PORT}`);
  });
});
