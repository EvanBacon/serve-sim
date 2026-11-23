import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { WebSocketServer } from "ws";

// `serve-sim type` end to end against a fake preview: what reaches the wire
// is what the guest's HID keyboard sees. Pins the 0x06 key opcode, Left Shift
// (0xE1) wrapping shifted characters outside the key press, CRLF collapsing to
// one Enter, and that text with a character the US table can't type is
// refused before anything is sent (no half-typed strings). The expected
// usages are spelled out from the HID Usage Page 0x07 table, not derived from
// the encoder under test.

const DEVICE = "TYPE-WIRE";
const cli = join(import.meta.dir, "..", "index.ts");
const SHIFT = 0xe1;

let server: Server;
let base = "";
let dir = "";
let httpRequests = 0;
let wsConnections = 0;
const frames: Buffer[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "serve-sim-type-wire-"));
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((req, res) => {
    httpRequests++;
    if (req.url?.startsWith("/api")) {
      // No inputAck/keyAck: an older server, so frames are fire-and-forget.
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ device: DEVICE }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== `/helper/${DEVICE}/ws`) return void socket.destroy();
    wsConnections++;
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => frames.push(Buffer.from(data as Buffer))));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  frames.length = 0;
  httpRequests = 0;
  wsConnections = 0;
});

function runCli(args: string[]): Promise<{ status: number | null; stderr: string }> {
  const env = { ...process.env };
  delete env.SERVE_SIM_URL;
  delete env.SERVE_SIM_AUTH_TOKEN;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["run", cli, "type", ...args, "--url", base, "-d", DEVICE], { env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

function keyFrames(): Array<[string, number]> {
  return frames.map((f) => {
    expect(f[0]).toBe(0x06);
    const body = JSON.parse(f.subarray(1).toString("utf8")) as { type: string; usage: number };
    return [body.type, body.usage];
  });
}

const press = (usage: number): Array<[string, number]> => [["down", usage], ["up", usage]];
const shifted = (usage: number): Array<[string, number]> => [["down", SHIFT], ...press(usage), ["up", SHIFT]];

describe("serve-sim type on the wire", () => {
  test("letters, shifted symbols and space reach the guest as HID usages with Shift outside the press", async () => {
    const r = await runCli(["Hi ~?_"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(keyFrames()).toEqual([
      ...shifted(0x0b), // H
      ...press(0x0c), // i
      ...press(0x2c), // space
      ...shifted(0x35), // ~ (Grave)
      ...shifted(0x38), // ? (Slash)
      ...shifted(0x2d), // _ (Minus)
    ]);
  }, 25_000);

  test("--file text with CRLF line endings presses Enter once per line break", async () => {
    const file = join(dir, "crlf.txt");
    writeFileSync(file, "a\r\nB\r\n");
    const r = await runCli(["--file", file]);
    expect(r.status).toBe(0);
    expect(keyFrames()).toEqual([...press(0x04), ...press(0x28), ...shifted(0x05), ...press(0x28)]);
  }, 25_000);

  for (const [text, bad] of [["café", "é"], ["ok 🙂", "🙂"]] as const) {
    test(`${JSON.stringify(text)} is refused naming ${JSON.stringify(bad)}, before contacting the server`, async () => {
      const r = await runCli([text]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`Unsupported character: ${JSON.stringify(bad)}`);
      expect({ httpRequests, wsConnections, frames: frames.length }).toEqual({ httpRequests: 0, wsConnections: 0, frames: 0 });
    }, 25_000);
  }
});
