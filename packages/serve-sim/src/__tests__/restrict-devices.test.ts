import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { request } from "http";
import { connect } from "net";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { deviceScope, type Refusal } from "../device-scope";
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

// An xcrun that lists no simulators and changes none, so a request that got
// past the scope could not reach a real simulator on this Mac.
const fakeXcrunDir = mkdtempSync(join(tmpdir(), "serve-sim-restrict-xcrun-"));
const realPath = process.env.PATH;

beforeAll(async () => {
  writeFileSync(join(fakeXcrunDir, "xcrun"), `#!/bin/sh\necho '{"devices":{}}'\n`);
  chmodSync(join(fakeXcrunDir, "xcrun"), 0o755);
  process.env.PATH = `${fakeXcrunDir}:${realPath}`;
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
      diagnostics: {
        sources: {
          host: async () => ({}),
          device: async (udid) => ({ udid }),
          sessions: async () => [{ udid: SERVED }, { udid: OTHER }],
        },
        cacheTtlMs: 0,
      },
    }),
  });
  port = preview.port;
});

afterAll(async () => {
  await preview?.stop(true);
  process.env.PATH = realPath;
  rmSync(fakeXcrunDir, { recursive: true, force: true });
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

/** The whole answer a WebSocket upgrade to `path` gets back (Bun's `ws` has no unexpected-response). */
function upgradeAnswer(path: string, method = "GET"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    let raw = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      raw += chunk;
    });
    socket.on("close", () => resolve(raw));
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

  test("still answers a boot or shutdown request that names no simulator with 400", async () => {
    for (const path of ["/grid/api/start", "/grid/api/shutdown"]) {
      const refused = await send(path, {});
      expect({ path, status: refused.status }).toEqual({ path, status: 400 });
    }
  });

  test("refuses another simulator named in any JSON body", async () => {
    for (const body of [
      { bundleId: "com.example.app", udid: OTHER },
      { bundleId: "com.example.app", device: OTHER },
      // The grid routes read `[udid]` as `udid`, as main does.
      { bundleId: "com.example.app", udid: [OTHER] },
      { bundleId: "com.example.app", device: [OTHER] },
    ]) {
      const refused = await send(`/reload?device=${SERVED}`, body);
      expect({ body, status: refused.status }).toEqual({ body, status: 404 });
      expect(JSON.parse(refused.body)).toEqual({ ok: false, error: `${OTHER} is not served by this preview` });
    }
    expect((await send("/grid/api/shutdown", { udid: [OTHER] })).status).toBe(404);
  });

  test("answers a POST upgrade without reading a body", async () => {
    const answer = await upgradeAnswer(`/helper/${OTHER}/ws`, "POST");
    expect(answer).toStartWith("HTTP/1.1 404 ");
    expect((await send(`/api?device=${SERVED}`)).status).toBe(200);
  });

  test("refuses a body over its cap before any route reads it", async () => {
    // The grid routes cap nothing of their own.
    for (const path of [`/reload?device=${SERVED}`, "/grid/api/start", "/grid/api/shutdown"]) {
      const refused = await send(path, { udid: SERVED, pad: "x".repeat(8 * 1024) });
      expect({ path, status: refused.status, body: JSON.parse(refused.body) }).toEqual({
        path,
        status: 413,
        body: { ok: false, error: "Body too large" },
      });
    }
    expect((await send("/grid/api/shutdown", { udid: OTHER, pad: "x".repeat(3 * 1024) })).status).toBe(404);
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
    expect(JSON.parse((await send("/api?device=")).body).error).toBe("An empty device is not served by this preview");
    const helper = await upgradeAnswer(`/helper/${OTHER}/ws`);
    expect(helper).toStartWith("HTTP/1.1 404 ");
    expect(helper).toContain(`${OTHER} is not served by this preview`);
  });

  test("has no DevTools, which list every simulator's web views", async () => {
    for (const path of ["/devtools", "/devtools/release", "/devtools/highlight"]) {
      const refused = await send(path, path === "/devtools" ? undefined : {});
      expect({ path, status: refused.status }).toEqual({ path, status: 404 });
      expect(refused.body).toContain("DevTools are off");
    }
    const devtools = await upgradeAnswer("/devtools/page/1");
    expect(devtools).toStartWith("HTTP/1.1 404 ");
    expect(devtools).toContain("DevTools are off");
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
    const diagnostics = JSON.parse((await send("/api/diagnostics")).body) as { event_log: Array<{ device?: string }> };
    expect(devicesIn(diagnostics.event_log)).toEqual([SERVED, null]);
    clearEventLogForTests();
  });

  test("leaves another simulator's session out of diagnostics", async () => {
    const bundle = JSON.parse((await send("/api/diagnostics")).body) as {
      sessions: Array<{ udid: string }>;
      devices: Array<{ udid: string }>;
    };
    expect(bundle.sessions.map((session) => session.udid)).toEqual([SERVED]);
    expect(bundle.devices.map((device) => device.udid)).toEqual([SERVED]);
  });

  test("fills an event limit with its own simulator's events", async () => {
    clearEventLogForTests();
    for (const device of [SERVED, undefined, OTHER, OTHER]) {
      recordEventLogEvent({ device, source: "exec", kind: "command", summary: `on ${device ?? "the host"}` });
    }
    const log = JSON.parse((await send("/api/event-log?limit=2")).body) as { events: Array<{ device?: string }> };
    expect(log.events.map((event) => event.device ?? null)).toEqual([SERVED, null]);
    clearEventLogForTests();
  });

  test("refuses the host shell, which reaches every simulator", () => {
    expect(() => simMiddleware({ restrictToDevices: [SERVED], allowExec: true })).toThrow(
      "restrictToDevices cannot be combined with allowExec",
    );
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

  test("leaves -l alone", () => {
    const scratch = mkdtempSync(join(tmpdir(), "serve-sim-restrict-"));
    try {
      // TMPDIR holds the state folder, so -l reads none of this Mac's previews.
      const result = spawnSync("bun", [cli, "--restrict-devices", "-l"], { encoding: "utf8", env: { ...process.env, TMPDIR: scratch } });
      expect(result.status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("refuses the host shell, which reaches every simulator", () => {
    const result = spawnSync("bun", [cli, "--restrict-devices", "--allow-exec"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--restrict-devices cannot be combined with --allow-exec");
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
    states: async (allows: (udid: string) => boolean) => [state(SERVED), state(OTHER)].filter((s) => allows(s.device)),
    simulators: async () => [{ udid: SERVED }, { udid: OTHER }],
    simulatorName: async (udid: string) => `name of ${udid}`,
    forgetBootedSimulators: () => {},
    isKnown: async () => true,
    events: (query?: { include?: (event: EventLogEntry) => boolean }) =>
      [entry(SERVED), entry(OTHER), entry(undefined)].filter(query?.include ?? (() => true)),
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
    expect([await scope.simulatorName(SERVED), await scope.simulatorName(OTHER)]).toEqual([`name of ${SERVED}`, undefined]);
    expect([scope.allows(SERVED), scope.allows(OTHER)]).toEqual([true, false]);
    expect(scope.events().map((event) => event.device)).toEqual([SERVED, undefined]);
    const heard: Array<string | undefined> = [];
    scope.onEvent((event) => heard.push(event.device));
    expect(heard).toEqual([SERVED, undefined]);
  });

  test("checks every simulator a request names, in its URL or its body", async () => {
    const scope = deviceScope([SERVED], read);
    const request = (fields: { requestedDevice?: string; helperDevice?: string; devtools?: boolean; body?: unknown }) => ({
      method: "POST",
      requestedDevice: fields.requestedDevice ?? null,
      helperDevice: fields.helperDevice ?? null,
      devtools: fields.devtools ?? false,
      body: async () => ({ kind: "read" as const, text: "", json: { ok: true as const, value: fields.body } }),
    });
    const refused: Refusal = { status: 404, message: `${OTHER} is not served by this preview` };
    const devtoolsOff: Refusal = { status: 404, message: "DevTools are off in a preview with --restrict-devices" };
    expect(await scope.check(request({ requestedDevice: SERVED, helperDevice: SERVED, body: { udid: SERVED, device: SERVED } }))).toBeNull();
    expect(await scope.check(request({ requestedDevice: OTHER }))).toEqual(refused);
    expect(await scope.check(request({ helperDevice: OTHER }))).toEqual(refused);
    expect(await scope.check(request({ body: { udid: OTHER } }))).toEqual(refused);
    expect(await scope.check(request({ body: { device: OTHER } }))).toEqual(refused);
    expect(await scope.check(request({ devtools: true }))).toEqual(devtoolsOff);
    // The check reads at most 4 KB of a body, whatever its route's own cap.
    const caps: Array<number | undefined> = [];
    const tooLarge = { ...request({}), body: async (limit?: { max: number }) => (caps.push(limit?.max), { kind: "too-large" as const }) };
    expect(await scope.check(tooLarge)).toEqual({ status: 413, message: "Body too large" });
    expect(caps).toEqual([4 * 1024]);
    // Without a restriction nothing is checked and the body is left unread.
    const unread = { ...request({ requestedDevice: OTHER, devtools: true }), body: () => Promise.reject(new Error("read")) };
    expect(await deviceScope(undefined, read).check(unread)).toBeNull();
  });

  test("an unrestricted scope allows everything", async () => {
    const scope = deviceScope(undefined, read);
    expect(await scope.states()).toHaveLength(2);
    expect(await scope.simulators()).toHaveLength(2);
    expect(scope.events()).toHaveLength(3);
    expect(scope.allows(OTHER)).toBe(true);
  });
});

describe("hostDeviceScope", () => {
  /** Whether `pid` still runs (a killed child stays a zombie until reaped). */
  const running = (pid: number) => {
    const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    return stat !== "" && !stat.startsWith("Z");
  };

  test("a restricted preview never stops another simulator's stale helper", () => {
    // A scratch state folder (STATE_DIR is under TMPDIR) holding one preview
    // of OTHER, and an xcrun that lists no booted simulator, so its helper
    // reads as stale.
    const scratch = mkdtempSync(join(tmpdir(), "serve-sim-restrict-"));
    const helper = spawn("sleep", ["30"]);
    try {
      mkdirSync(join(scratch, "serve-sim"));
      mkdirSync(join(scratch, "bin"));
      writeFileSync(join(scratch, "bin", "xcrun"), `#!/bin/sh\necho '{"devices":{}}'\n`);
      chmodSync(join(scratch, "bin", "xcrun"), 0o755);
      const env: Record<string, string | undefined> = {
        ...process.env,
        TMPDIR: scratch,
        PATH: `${join(scratch, "bin")}:${process.env.PATH}`,
      };
      delete env.SERVE_SIM_DEVICE_SET;
      writeFileSync(
        join(scratch, "serve-sim", `server-${OTHER}.json`),
        JSON.stringify({ pid: helper.pid, port: 1, device: OTHER, url: "", streamUrl: "", wsUrl: "" }),
      );
      const readStates = (restrict: string[] | undefined) => {
        const script =
          `const { hostDeviceScope } = await import(${JSON.stringify(join(import.meta.dir, "..", "device-scope.ts"))});` +
          `await hostDeviceScope(${JSON.stringify(restrict)}).states();`;
        const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env });
        expect(result.stderr).toBe("");
      };
      readStates([SERVED]);
      expect(running(helper.pid!)).toBe(true);
      // An unrestricted preview recycles it, so the state above was stale.
      readStates(undefined);
      expect(running(helper.pid!)).toBe(false);
    } finally {
      helper.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
