import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { request } from "http";
import { connect } from "net";
import WebSocket from "ws";
import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

// `restrictToDevices` (`serve-sim --restrict-devices`): a preview on a shared
// Mac serves only its own simulators, so neither its page nor its API can
// boot, shut down, stream or drive one that someone else is using.

delete process.env.SERVE_SIM_AUTH_TOKEN;
(globalThis as Record<string, unknown>).__PREVIEW_HTML_B64__ = Buffer.from(
  "<!doctype html><html><head><!--__SIM_PREVIEW_CONFIG__--></head></html>",
).toString("base64");

const SERVED = "AAAAAAAA-0000-0000-0000-000000000001";
const OTHER = "BBBBBBBB-0000-0000-0000-000000000002";

let preview: PreviewServer;
let port: number;

beforeAll(async () => {
  // servePreview's front server, because Bun 1.3's node:http swallows an
  // upgrade rejection's status line (remote-access.test.ts).
  preview = await servePreview({
    port: 0,
    host: "127.0.0.1",
    middleware: simMiddleware({
      basePath: "/",
      device: SERVED,
      restrictToDevices: [SERVED],
      // Every well-formed udid counts as booted, so only the restriction refuses.
      isKnownDevice: async () => true,
    }),
  });
  port = preview.port;
});

afterAll(async () => {
  await preview?.stop(true);
});

function send(path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: payload === undefined ? "GET" : "POST",
        headers: payload === undefined ? {} : { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function controlRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    const timer = setTimeout(() => reject(new Error("no reply")), 4000);
    ws.on("error", reject);
    ws.on("open", () => ws.send("{}"));
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message.ready) {
        ws.send(JSON.stringify(body));
        return;
      }
      clearTimeout(timer);
      ws.terminate();
      resolve(message);
    });
  });
}

/** The status line a WebSocket upgrade to `path` gets back (Bun's `ws` has no unexpected-response). */
function upgradeStatus(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    let raw = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.includes("\r\n")) {
        socket.destroy();
        resolve(raw.slice(0, raw.indexOf("\r\n")));
      }
    });
    socket.on("error", reject);
  });
}

describe("restrictToDevices", () => {
  test("refuses to boot or shut down a simulator it does not serve", async () => {
    for (const path of ["/grid/api/start", "/grid/api/shutdown"]) {
      const refused = await send(path, { udid: OTHER });
      expect({ path, status: refused.status }).toEqual({ path, status: 404 });
      expect(JSON.parse(refused.body)).toEqual({ ok: false, error: `${OTHER} is not served by this preview` });
    }
  });

  test("matches UDIDs case-insensitively", async () => {
    const refused = await send("/grid/api/shutdown", { udid: OTHER.toLowerCase() });
    expect(refused.status).toBe(404);
    // A served device reaches simctl (which fails for this made-up udid).
    const reached = await send("/grid/api/shutdown", { udid: SERVED.toLowerCase() });
    expect(reached.status).not.toBe(404);
  });

  test("refuses another simulator's stream, input and page routes", async () => {
    for (const path of [`/helper/${OTHER}/stream.mjpeg`, `/helper/${OTHER}/config`, `/api?device=${OTHER}`, `/?device=${OTHER}`]) {
      const refused = await send(path);
      expect({ path, status: refused.status }).toEqual({ path, status: 404 });
      expect(refused.body).toContain("is not served by this preview");
    }
    expect(await upgradeStatus(`/helper/${OTHER}/ws`)).toMatch(/^HTTP\/1\.1 404 /);
  });

  test("refuses host actions and simulator settings for another simulator", async () => {
    const action = await controlRequest({ id: 1, rpc: { method: "home", params: { udid: OTHER } } });
    expect(String(action.error ?? action.stderr)).toContain(`unknown or not booted device: ${OTHER}`);
    const setting = await controlRequest({ id: 2, ui: { device: OTHER, option: "appearance" } });
    expect(String(setting.error)).toContain(`${OTHER} is not served by this preview`);
  });

  test("still serves its own simulator", async () => {
    const api = await send(`/api?device=${SERVED}`);
    expect(api.status).toBe(200);
  });
});
