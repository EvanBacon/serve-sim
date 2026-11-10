import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import type { AddressInfo } from "net";
import { join } from "path";

// `serve-sim record` against a fake server: the MP4 is saved as before and the
// `.index.jsonl` sidecar lands next to it unless `--no-index`.

const DEVICE = "RECORD-INDEX-CLI";
const cli = join(import.meta.dir, "..", "index.ts");
const INDEX_TEXT = '{"type":"header","version":1}\n{"type":"footer","frames":0}\n';

let server: Server;
let port = 0;
let indexAvailable = true;
const requests: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "serve-sim-record-index-"));

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(`${req.method} ${url}`);
    const path = url.split("?")[0];
    const prefix = `/helper/${DEVICE}`;
    if (path === "/api") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ device: DEVICE }));
    } else if (path === `${prefix}/recording/start`) {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ recording: true, startedAt: "2026-11-09T12:00:00.000Z", token: "TOKEN-1" }));
    } else if (path === `${prefix}/recording`) {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ recording: true, startedAt: "2026-11-09T12:00:00.000Z" }));
    } else if (path === `${prefix}/recording/stop`) {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "X-Serve-Sim-Recording": JSON.stringify({ width: 2, height: 4, fps: 60, frames: 6, duration: 0.1 }),
      }).end("fake-mp4");
    } else if (path === `${prefix}/recording/index` && indexAvailable) {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end(INDEX_TEXT);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "index_not_found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function runRecord(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.SERVE_SIM_URL;
  delete env.SERVE_SIM_AUTH_TOKEN;
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cli, "record", "-t", "50ms", "--url", `http://127.0.0.1:${port}`, "-d", DEVICE, ...args], { env });
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

describe("serve-sim record index sidecar", () => {
  test("writes <name>.index.jsonl next to the MP4 by default", async () => {
    requests.length = 0;
    indexAvailable = true;
    const out = join(dir, "clip.mp4");
    const r = await runRecord(["-o", out]);
    expect(r.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("fake-mp4");
    expect(readFileSync(join(dir, "clip.index.jsonl"), "utf8")).toBe(INDEX_TEXT);
    expect(requests).toContain(`GET /helper/${DEVICE}/recording/index?token=TOKEN-1&file=clip.mp4`);
    // stdout keeps its one "Saved" line; the index is reported on stderr.
    expect(r.stdout.trim().split("\n")).toEqual([`Saved ${out} (2x4 @ 60 fps, 6 frames, 0.10s)`]);
    expect(r.stderr).toContain(`Saved index ${join(dir, "clip.index.jsonl")}`);
  }, 25_000);

  test("--no-index skips the request and the file", async () => {
    requests.length = 0;
    const out = join(dir, "plain.mp4");
    const r = await runRecord(["-o", out, "--no-index"]);
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(dir, "plain.index.jsonl"))).toBe(false);
    expect(requests.some((line) => line.includes("/recording/index"))).toBe(false);
  }, 25_000);

  test("a server without indexes still saves the MP4 and exits 0", async () => {
    indexAvailable = false;
    const out = join(dir, "old-server.mp4");
    const r = await runRecord(["-o", out]);
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(dir, "old-server.index.jsonl"))).toBe(false);
    expect(r.stderr).toContain("No recording index");
  }, 25_000);

  test("help advertises --no-index", async () => {
    const help = await new Promise<string>((resolve) => {
      const child = spawn("bun", ["run", cli, "record", "--help"]);
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", () => resolve(stdout));
    });
    expect(help).toContain("--no-index");
  }, 25_000);
});
