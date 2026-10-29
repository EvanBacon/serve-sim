import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { request } from "http";
import { connect } from "net";
import { join } from "path";
import WebSocket from "ws";
import { EVERY_SIMULATOR, deviceScope } from "../device-scope";
import { clearEventLogForTests, recordEventLogEvent, type EventLogEntry } from "../event-log";
import { simMiddleware, type ServeSimState } from "../middleware";
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

/** The first `data:` frame of the SSE stream at `path`. */
function firstEvent(path: string): Promise<{ events: Array<{ device?: string }> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      let text = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        text += chunk;
        const frame = /^data: (.*)$/m.exec(text);
        if (frame) {
          req.destroy();
          resolve(JSON.parse(frame[1]!));
        }
      });
    });
    req.on("error", reject);
    req.end();
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

  test("still answers a malformed boot or shutdown request with 400", async () => {
    for (const path of ["/grid/api/start", "/grid/api/shutdown"]) {
      const refused = await send(path, { udid: "not-a-udid" });
      expect({ path, status: refused.status }).toEqual({ path, status: 400 });
    }
  });

  test("refuses a request that names another simulator anywhere", async () => {
    expect((await send(`/helper/${SERVED}/config?device=${OTHER}`)).status).toBe(404);
    expect((await send("/devtools-frontend/inspector.html")).status).toBe(404);
  });

  test("matches UDIDs case-insensitively", async () => {
    expect((await send("/grid/api/shutdown", { udid: OTHER.toLowerCase() })).status).toBe(404);
    expect((await send(`/api?device=${SERVED.toLowerCase()}`)).status).toBe(200);
  });

  test("refuses another simulator's stream, input and page routes", async () => {
    for (const path of [
      `/helper/${OTHER}/stream.mjpeg`,
      `/helper/${OTHER}/config`,
      `/?device=${OTHER}`,
      `/api?device=${OTHER}`,
      `/ax?device=${OTHER}`,
      `/appstate?device=${OTHER}`,
      `/api/events?device=${OTHER}`,
      // An empty selection would otherwise fall back to any preview's state.
      "/api?device=",
      "/ax?device=",
    ]) {
      const refused = await send(path);
      expect({ path, status: refused.status }).toEqual({ path, status: 404 });
      expect(refused.body).toContain("is not served by this preview");
    }
    expect(await upgradeStatus(`/helper/${OTHER}/ws`)).toMatch(/^HTTP\/1\.1 404 /);
  });

  test("has no DevTools, which list every simulator's web views", async () => {
    for (const path of ["/devtools", "/devtools/release", "/devtools/highlight"]) {
      const refused = await send(path, path === "/devtools" ? undefined : {});
      expect({ path, status: refused.status }).toEqual({ path, status: 404 });
      expect(refused.body).toContain("DevTools are off");
    }
    expect(await upgradeStatus("/devtools/page/1")).toMatch(/^HTTP\/1\.1 404 /);
  });

  test("refuses host actions and simulator settings for another simulator", async () => {
    const action = await controlRequest({ id: 1, rpc: { method: "home", params: { udid: OTHER } } });
    expect(String(action.error ?? action.stderr)).toContain(`unknown or not booted device: ${OTHER}`);
    const setting = await controlRequest({ id: 2, ui: { device: OTHER, option: "appearance" } });
    expect(String(setting.error)).toContain(`${OTHER} is not served by this preview`);
  });

  test("logs no events for another simulator", async () => {
    clearEventLogForTests();
    for (const device of [SERVED, OTHER, undefined]) {
      recordEventLogEvent({ device, source: "exec", kind: "command", summary: `on ${device ?? "the host"}` });
    }
    const devicesIn = (events: Array<{ device?: string }>) => events.map((event) => event.device ?? null);
    const log = JSON.parse((await send("/api/event-log")).body) as { events: Array<{ device?: string }> };
    expect(devicesIn(log.events)).toEqual([SERVED, null]);
    const stream = await firstEvent("/api/event-log/events");
    expect(devicesIn(stream.events)).toEqual([SERVED, null]);
    clearEventLogForTests();
  });

  test("still serves its own simulator", async () => {
    const api = await send(`/api?device=${SERVED}`);
    expect(api.status).toBe(200);
  });
});

describe("serve-sim --restrict-devices", () => {
  const cli = join(import.meta.dir, "..", "index.ts");

  test("is documented in --help", () => {
    const result = spawnSync("bun", [cli, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--restrict-devices");
  });

  test("needs the simulators it serves named", () => {
    const result = spawnSync("bun", [cli, "--restrict-devices"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("name at least one");
  });

  test("refuses modes without the preview server", () => {
    for (const mode of ["--detach", "--no-preview"]) {
      const result = spawnSync("bun", [cli, "--restrict-devices", mode], { encoding: "utf8" });
      expect({ mode, status: result.status }).toEqual({ mode, status: 1 });
      expect(result.stderr).toContain("--restrict-devices applies to the preview server");
    }
  });
});

describe("deviceScope", () => {
  const state = (device: string): ServeSimState => ({
    pid: 1, port: 1, device, url: "", streamUrl: "", wsUrl: "",
  });
  const entry = (device: string | undefined): EventLogEntry => ({
    id: 1, timestamp: "", source: "exec", kind: "command", msg: "", summary: "", device,
  });
  const read = {
    states: async () => [state(SERVED), state(OTHER)],
    simulators: async () => [{ udid: SERVED }, { udid: OTHER }],
    isKnown: async () => true,
    events: () => [entry(SERVED), entry(OTHER), entry(undefined)],
    onEvent: (subscriber: (event: EventLogEntry) => void) => {
      for (const device of [SERVED, OTHER, undefined]) subscriber(entry(device));
      return () => {};
    },
  };

  test("a route that reads through a restricted scope sees only the served simulators", async () => {
    const scope = deviceScope([SERVED.toLowerCase()], read);
    expect(await scope.states()).toEqual([state(SERVED)]);
    expect(await scope.simulators()).toEqual([{ udid: SERVED }]);
    expect(await scope.isKnown(SERVED)).toBe(true);
    expect(await scope.isKnown(OTHER)).toBe(false);
    expect([scope.allows(SERVED), scope.allows(OTHER), scope.allows(EVERY_SIMULATOR)]).toEqual([true, false, false]);
    expect(scope.events().map((event) => event.device)).toEqual([SERVED, undefined]);
    const heard: Array<string | undefined> = [];
    scope.onEvent((event) => heard.push(event.device));
    expect(heard).toEqual([SERVED, undefined]);
  });

  test("an unrestricted scope allows everything", async () => {
    const scope = deviceScope(undefined, read);
    expect(await scope.states()).toHaveLength(2);
    expect(await scope.simulators()).toHaveLength(2);
    expect(scope.events()).toHaveLength(3);
    expect([scope.allows(OTHER), scope.allows(EVERY_SIMULATOR)]).toEqual([true, true]);
  });

  test("simMiddleware reads simulators and events only through its scope", () => {
    // A route that called one of these itself would list or drive every
    // simulator in a restricted preview.
    const source = readFileSync(join(import.meta.dir, "..", "middleware.ts"), "utf-8");
    const body = source.slice(source.indexOf("export function simMiddleware("));
    for (const reader of [
      "readServeSimStates(", "listAllSimulators(", "getBootedUdids(", "isBooted(", "readEventLog(", "subscribeEventLog(",
    ]) {
      expect({ reader, called: body.includes(reader) }).toEqual({ reader, called: false });
    }
  });
});
