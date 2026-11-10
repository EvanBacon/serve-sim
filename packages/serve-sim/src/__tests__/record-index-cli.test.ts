import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import type { AddressInfo } from "net";
import { join } from "path";
import { recordingFileName } from "../recording";

// `serve-sim record` against a fake server: the MP4 is saved as before and the
// `.index.jsonl` sidecar lands next to it unless `--no-index`.

const DEVICE = "RECORD-INDEX-CLI";
const cli = join(import.meta.dir, "..", "index.ts");
const INDEX_TEXT = '{"type":"header","version":1}\n{"type":"footer","frames":0}\n';

let server: Server;
let port = 0;
/**
 * How the fake server answers `/recording/index`: an HTTP status, or
 * "expired" for a new server's `404 {"error":"index_not_found"}`.
 */
let indexStatus: number | "expired" = 200;
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
    } else if (path === `${prefix}/recording/index` && indexStatus === 200) {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end(INDEX_TEXT);
    } else if (path === `${prefix}/recording/index` && indexStatus === "expired") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "index_not_found" }));
    } else if (path === `${prefix}/recording/index` && indexStatus !== 404) {
      res.writeHead(indexStatus as number, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "boom" }));
    } else {
      // An older server: no such route.
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
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

function runRecord(args: string[], cwd?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.SERVE_SIM_URL;
  delete env.SERVE_SIM_AUTH_TOKEN;
  // Same zone as this process (bun test runs in UTC), so default file names match.
  env.TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cli, "record", "-t", "50ms", "--url", `http://127.0.0.1:${port}`, "-d", DEVICE, ...args], { env, cwd });
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
    indexStatus = 200;
    const out = join(dir, "clip.mp4");
    const r = await runRecord(["-o", out]);
    expect(r.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("fake-mp4");
    expect(readFileSync(join(dir, "clip.index.jsonl"), "utf8")).toBe(INDEX_TEXT);
    expect(requests).toContain(`POST /helper/${DEVICE}/recording/start?index=1`);
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
    // Nothing is collected server-side either: the start doesn't ask for it.
    expect(requests).toContain(`POST /helper/${DEVICE}/recording/start`);
    expect(r.stderr).not.toContain("index");
  }, 25_000);

  test("a server without indexes (404) saves the MP4 silently and exits 0", async () => {
    indexStatus = 404;
    const out = join(dir, "old-server.mp4");
    const r = await runRecord(["-o", out]);
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(dir, "old-server.index.jsonl"))).toBe(false);
    expect(r.stderr).not.toContain("index");
  }, 25_000);

  test("an expired or evicted index (index_not_found) warns but still exits 0", async () => {
    indexStatus = "expired";
    const out = join(dir, "expired.mp4");
    const r = await runRecord(["-o", out]);
    expect(r.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("fake-mp4");
    expect(existsSync(join(dir, "expired.index.jsonl"))).toBe(false);
    expect(r.stderr).toContain("Could not fetch the recording index (expired or evicted); saved the MP4 only.");
  }, 25_000);

  test("any other index failure warns but still exits 0", async () => {
    indexStatus = 500;
    const out = join(dir, "broken.mp4");
    const r = await runRecord(["-o", out]);
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(r.stderr).toContain("Could not fetch the recording index (HTTP 500)");
  }, 25_000);

  test("a leftover sidecar makes the default name move on, so both files save", async () => {
    indexStatus = 200;
    const cwd = join(dir, "leftover");
    mkdirSync(cwd);
    // Orphaned sidecars (their MP4s deleted) for every second the run may land on.
    const now = Date.now();
    for (let s = -2; s <= 20; s++) {
      const name = recordingFileName(new Date(now + s * 1000)).replace(/\.mp4$/, ".index.jsonl");
      writeFileSync(join(cwd, name), "stale\n");
    }
    const r = await runRecord([], cwd);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("Could not save");
    const mp4s = readdirSync(cwd).filter((f) => f.endsWith(".mp4"));
    expect(mp4s).toHaveLength(1);
    expect(mp4s[0]).toMatch(/-2\.mp4$/);
    expect(readFileSync(join(cwd, mp4s[0]!.replace(/\.mp4$/, ".index.jsonl")), "utf8")).toBe(INDEX_TEXT);
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
