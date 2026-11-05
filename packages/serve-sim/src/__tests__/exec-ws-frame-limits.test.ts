import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { createRequire } from "module";
import { connect } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { EXEC_WS_LIMITS } from "../exec-ws";
import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

// WebSocket frame-limit hardening for `/exec-ws`:
//   - the resolved `ws` is a release with fragment/chunk limits (>= 8.21.1)
//   - the control channel sets maxPayload / maxFragments / maxBufferedChunks
//     explicitly instead of relying on ws defaults
//   - a client that never finishes a fragmented first message is closed
//     (1008) before any token check, and the server keeps serving HTTP
//
// The close-on-limit assertions run the server under Node from a
// node-targeted bundle (fixtures/exec-ws-limits-harness.ts) because that's
// what the `serve-sim` bin does and it exercises the real `ws` package;
// under `bun test`, `import "ws"` is Bun's native shim.

const PORT_BUN = 9374;
const PORT_NODE = 9375;
const EXEC_TOKEN = "exec-ws-frame-limits-token";

function cmpSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

test("resolved ws is >= 8.21.1", () => {
  const version: string = createRequire(import.meta.url)("ws/package.json").version;
  expect(cmpSemver(version, "8.21.1")).toBeGreaterThanOrEqual(0);
});

test("exec-ws frame limits are explicit and tight", () => {
  expect(EXEC_WS_LIMITS.maxPayload).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(EXEC_WS_LIMITS.maxFragments).toBeGreaterThan(0);
  expect(EXEC_WS_LIMITS.maxFragments).toBeLessThanOrEqual(1024);
  expect(EXEC_WS_LIMITS.maxBufferedChunks).toBeGreaterThan(0);
});

/** One masked client frame with a 1-byte payload. */
function tinyFrame(opcode: number, fin: boolean): Buffer {
  return Buffer.from([(fin ? 0x80 : 0) | opcode, 0x81, 0, 0, 0, 0, 0x7b]);
}

/** Upgrade `/exec-ws`, then send `count` 1-byte fragments of one never-finished message. */
function floodFragments(
  port: number,
  count: number,
  holdMs = 3000,
): Promise<{ upgraded: boolean; closed: boolean; closeCode: number | null }> {
  return new Promise((resolve) => {
    const host = `127.0.0.1:${port}`;
    const sock = connect({ port, host: "127.0.0.1" });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let closeCode: number | null = null;
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ upgraded, closed, closeCode });
    };
    const timer = setTimeout(() => finish(false), holdMs);
    sock.on("connect", () => {
      sock.write(
        `GET /exec-ws HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://${host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        upgraded = / 101 /.test(buf.subarray(0, end).toString("latin1"));
        buf = buf.subarray(end + 4);
        if (!upgraded) return finish(true);
        const frames = [tinyFrame(0x1, false)];
        for (let i = 1; i < count; i++) frames.push(tinyFrame(0x0, false));
        sock.write(Buffer.concat(frames));
      }
      const i = buf.indexOf(0x88);
      if (i >= 0 && buf.length >= i + 4) closeCode = buf.readUInt16BE(i + 2);
    });
    sock.on("error", () => finish(true));
    sock.on("close", () => finish(true));
  });
}

async function httpAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/no-such-route`, { headers: { Host: `127.0.0.1:${port}` } });
    await res.arrayBuffer();
    return res.status > 0;
  } catch {
    return false;
  }
}

/** Authenticate with the exec token and expect `{ready:true}` — the normal path still works. */
function readyRoundTrip(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const host = `127.0.0.1:${port}`;
    const ws = new WebSocket(`ws://${host}/exec-ws`, { headers: { Host: host, Origin: `http://${host}` } } as never);
    const timer = setTimeout(() => (ws.close(), resolve(false)), 3000);
    ws.onopen = () => ws.send(JSON.stringify({ token: EXEC_TOKEN }));
    ws.onmessage = (e) => {
      if (JSON.parse(String(e.data)).ready === true) {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      }
    };
    ws.onerror = () => (clearTimeout(timer), resolve(false));
  });
}

// --- Bun runtime (in-process) ---

let bunServer: PreviewServer | null = null;
let child: ChildProcess | null = null;
let tmpDir: string | null = null;
let bundleHasFragmentLimit = false;
const NODE = spawnSync("node", ["--version"]).status === 0 ? "node" : null;

beforeAll(async () => {
  bunServer = await servePreview({
    port: PORT_BUN,
    middleware: simMiddleware({ basePath: "/", allowExec: true, execToken: EXEC_TOKEN, device: "DEVICE-A" }),
    host: "127.0.0.1",
  });

  if (!NODE) return;
  tmpDir = mkdtempSync(join(tmpdir(), "serve-sim-ws-limits-"));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures/exec-ws-limits-harness.ts")],
    target: "node",
    outdir: tmpDir,
    define: { __PREVIEW_HTML_B64__: JSON.stringify("") },
  });
  if (!built.success) throw new AggregateError(built.logs, "harness build failed");
  const out = built.outputs[0]!.path;
  bundleHasFragmentLimit = readFileSync(out, "utf8").includes("Too many message fragments");
  child = spawn(NODE, [out, String(PORT_NODE), EXEC_TOKEN], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("harness did not start")), 10_000);
    child!.stdout!.on("data", (d) => {
      buf += d.toString();
      if (buf.includes('"ready":true')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child!.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited early (${code})`));
    });
  });
}, 30_000);

afterAll(() => {
  bunServer?.stop(true);
  child?.kill("SIGKILL");
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test("bun runtime: fragment flood on /exec-ws does not take the server down", async () => {
  const r = await floodFragments(PORT_BUN, EXEC_WS_LIMITS.maxFragments * 4, 1000);
  expect(r.upgraded).toBe(true);
  expect(await httpAlive(PORT_BUN)).toBe(true);
  expect(await readyRoundTrip(PORT_BUN)).toBe(true);
});

test.skipIf(!NODE)("node bundle carries ws's fragment limit (real ws, not a shim)", () => {
  expect(bundleHasFragmentLimit).toBe(true);
});

test.skipIf(!NODE)("node, real ws: unfinished fragmented first message past maxFragments is closed with 1008; server survives", async () => {
  // Above our explicit limit but far below ws's built-in default (16384), so
  // this fails if the explicit option is ever dropped.
  const r = await floodFragments(PORT_NODE, EXEC_WS_LIMITS.maxFragments * 4);
  expect(r.upgraded).toBe(true);
  expect(r.closed).toBe(true);
  expect(r.closeCode).toBe(1008);
  expect(child!.exitCode).toBeNull();
  expect(await httpAlive(PORT_NODE)).toBe(true);
  expect(await readyRoundTrip(PORT_NODE)).toBe(true);
});

test.skipIf(!NODE)("node, real ws: fragmented message under the limit is not cut off", async () => {
  const r = await floodFragments(PORT_NODE, 16, 500);
  expect(r.upgraded).toBe(true);
  expect(r.closed).toBe(false);
});
