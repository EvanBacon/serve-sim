import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { join } from "path";
import { WebSocketServer } from "ws";

// What `serve-sim button` and `serve-sim rotate` put on the HID socket. The
// server half (0x04 → button()/buttonHid(), 0x07 → setOrientation) is covered
// by hid-wire-native-args; this pins the CLI half, so a renamed button, a
// changed HID page/usage, or a dropped orientation frame is caught without a
// simulator. Each run targets its own device id on one local fake server.

const ACK_TAG = 0x84;
const cli = join(import.meta.dir, "..", "index.ts");

let PORT = 0;
let server: Server;
const framesByDevice = new Map<string, Buffer[]>();
const upgradesByDevice = new Map<string, number>();

beforeAll(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api") {
      const device = url.searchParams.get("device");
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ device, inputAck: true, keyAck: true }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    const device = /^\/helper\/([^/]+)\/ws$/.exec(req.url ?? "")?.[1];
    if (!device) { socket.destroy(); return; }
    upgradesByDevice.set(device, (upgradesByDevice.get(device) ?? 0) + 1);
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => {
      const frame = Buffer.from(data as Buffer);
      const list = framesByDevice.get(device) ?? [];
      list.push(frame);
      framesByDevice.set(device, list);
      const body = JSON.parse(frame.subarray(1).toString()) as { ack?: number };
      if (typeof body.ack === "number") {
        ws.send(Buffer.concat([Buffer.from([ACK_TAG]), Buffer.from(JSON.stringify({ ack: body.ack, ok: true }))]));
      }
    }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  PORT = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.SERVE_SIM_URL;
  delete env.SERVE_SIM_AUTH_TOKEN;
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cli, ...args, "--url", `http://127.0.0.1:${PORT}`], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Frames one device received, as [tag, body-without-ack-id]. */
function framesFor(device: string): Array<[number, Record<string, unknown>]> {
  return (framesByDevice.get(device) ?? []).map((frame) => {
    const { ack: _ack, ...body } = JSON.parse(frame.subarray(1).toString()) as Record<string, unknown>;
    return [frame[0]!, body];
  });
}

describe("serve-sim button", () => {
  // DeviceKit chrome.json usagePage/usage for buttons that have no named idb
  // event source; the helper injects them as arbitrary HID usages.
  const HID_BUTTONS: Array<[string, number, number]> = [
    ["power", 12, 48],
    ["volume-up", 12, 233],
    ["volume-down", 12, 234],
    ["action", 11, 45],
    ["side-button", 12, 149],
    ["digital-crown", 12, 64],
  ];

  test("buttons without a named source send their HID page and usage in one 0x04 frame", async () => {
    const runs = await Promise.all(HID_BUTTONS.map(([name]) => runCli(["button", name, "-d", `BTN-${name}`])));
    runs.forEach((run, i) => expect({ name: HID_BUTTONS[i]![0], status: run.status, stderr: run.stderr })
      .toEqual({ name: HID_BUTTONS[i]![0], status: 0, stderr: "" }));
    for (const [name, page, usage] of HID_BUTTONS) {
      expect(framesFor(`BTN-${name}`)).toEqual([[0x04, { button: name, page, usage }]]);
    }
  }, 60_000);

  test("named buttons go by name only, and a bare `button` presses home", async () => {
    const runs = await Promise.all([
      runCli(["button", "home", "-d", "BTN-home"]),
      runCli(["button", "lock", "-d", "BTN-lock"]),
      runCli(["button", "-d", "BTN-default"]),
    ]);
    for (const run of runs) expect(run.status).toBe(0);
    expect(framesFor("BTN-home")).toEqual([[0x04, { button: "home" }]]);
    expect(framesFor("BTN-lock")).toEqual([[0x04, { button: "lock" }]]);
    expect(framesFor("BTN-default")).toEqual([[0x04, { button: "home" }]]);
  }, 60_000);
});

describe("serve-sim rotate", () => {
  const ORIENTATIONS = ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"];

  test("sends one 0x07 frame naming the orientation", async () => {
    const runs = await Promise.all(ORIENTATIONS.map((o) => runCli(["rotate", o, "-d", `ROT-${o}`])));
    for (const run of runs) expect(run.status).toBe(0);
    for (const orientation of ORIENTATIONS) {
      expect(framesFor(`ROT-${orientation}`)).toEqual([[0x07, { orientation }]]);
    }
  }, 60_000);

  test("an unknown orientation exits 1 with usage and never opens the HID socket", async () => {
    const run = await runCli(["rotate", "sideways", "-d", "ROT-bad"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Usage: serve-sim rotate <portrait|portrait_upside_down|landscape_left|landscape_right>");
    expect(upgradesByDevice.get("ROT-bad")).toBeUndefined();
    expect(framesFor("ROT-bad")).toEqual([]);
  }, 30_000);
});
