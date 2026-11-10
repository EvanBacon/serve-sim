import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bufferUrlForWsUrl, formatBufferView, runBufferCommand, type BufferCliDeps } from "../buffer-cli";
import type { BufferStats, BufferView, RollingBufferOptions } from "../rolling-buffer";

const WS = "ws://127.0.0.1:3400/helper/DEV/ws";
const dir = mkdtempSync(join(tmpdir(), "serve-sim-buffer-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const VIEW: BufferView & { enabled: true; options: RollingBufferOptions; stats: BufferStats & { maxBytes: number } } = {
  enabled: true,
  options: { seconds: 20, fps: 4, maxDimension: 640, quality: 0.6, maxBytes: 24 << 20 },
  stats: { samples: 3, frames: 2, events: 1, bytes: 61_440, maxBytes: 24 << 20, unchanged: 1, duplicates: 0, evictedFrames: 0, errors: 0 },
  origin: "2026-11-10T12:00:00.000Z",
  now: "2026-11-10T12:00:02.000Z",
  samples: [
    { t: 0, at: "2026-11-10T12:00:00.000Z", frame: 1, changed: true },
    { t: 0.25, at: "2026-11-10T12:00:00.250Z", frame: 1, changed: false },
    { t: 1.5, at: "2026-11-10T12:00:01.500Z", frame: 2, changed: true },
  ],
  frames: [
    { id: 1, t: 0, at: "2026-11-10T12:00:00.000Z", bytes: 30_720, width: 294, height: 640, sourceWidth: 1206, sourceHeight: 2622 },
    { id: 2, t: 1.5, at: "2026-11-10T12:00:01.500Z", bytes: 30_720, width: 294, height: 640, sourceWidth: 1206, sourceHeight: 2622 },
  ],
  events: [
    { type: "event", t: 1.2, id: 9, timestamp: "2026-11-10T12:00:01.200Z", kind: "tap", summary: "Tap (0.50, 0.90)", x: 0.5, y: 0.9, frame: 1, nextChange: { frame: 2, t: 1.5, after: 0.3 } },
  ],
};

type Call = { url: string; method: string; headers: Record<string, string> };

function deps(routes: Record<string, () => Response>, overrides: Partial<BufferCliDeps> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stdout: Uint8Array[] = [];
  const d: BufferCliDeps = {
    wsUrl: WS,
    headers: { Authorization: "Bearer T" },
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
      const path = new URL(url).pathname.replace("/helper/DEV", "");
      const route = routes[path];
      return route ? route() : new Response("Not Found", { status: 404 });
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    writeStdout: (bytes) => stdout.push(bytes),
    stdoutIsTTY: true,
    tmpdir: () => dir,
    ...overrides,
  };
  return { d, calls, out, err, stdout };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const jpegRoute = (id: number) => () => new Response(new Uint8Array([0xff, 0xd8, id, 0xff, 0xd9]), {
  headers: { "Content-Type": "image/jpeg", "X-Serve-Sim-Buffer-Frame": JSON.stringify({ id, at: "2026-11-10T12:00:01.500Z" }) },
});

describe("bufferUrlForWsUrl", () => {
  test("derives helper buffer URLs from the HID socket URL", () => {
    expect(bufferUrlForWsUrl(WS)).toBe("http://127.0.0.1:3400/helper/DEV/buffer");
    expect(bufferUrlForWsUrl(WS, "frame", { id: "3" })).toBe("http://127.0.0.1:3400/helper/DEV/buffer/frame?id=3");
    expect(bufferUrlForWsUrl("wss://x.example/base/helper/DEV/ws", "start")).toBe("https://x.example/base/helper/DEV/buffer/start");
    expect(bufferUrlForWsUrl("ws://127.0.0.1:3400/helper/DEV/config")).toBeNull();
  });
});

describe("formatBufferView", () => {
  test("lists changed frames and events newest-relative, with the next change after each event", () => {
    const text = formatBufferView(VIEW);
    expect(text).toContain("20 s window at 4 fps");
    expect(text).toContain("2 frames, 60.0 KB of 24.0 MB");
    const lines = text.split("\n");
    const frameLine = lines.findIndex((l) => /frame 1\s+294x640/.test(l));
    const tapLine = lines.findIndex((l) => l.includes("tap"));
    const frame2Line = lines.findIndex((l) => /frame 2\s+294x640/.test(l));
    expect(frameLine).toBeLessThan(tapLine);
    expect(tapLine).toBeLessThan(frame2Line);
    expect(lines[tapLine]).toContain("-0.80s");
    expect(lines[tapLine]).toContain("frame 2 after 0.30s");
    expect(lines[frame2Line]).toContain("-0.50s");
  });

  test("off and empty buffers say how to proceed", () => {
    expect(formatBufferView({ enabled: false })).toContain("serve-sim buffer start");
    expect(formatBufferView({ ...VIEW, samples: [], frames: [], events: [], origin: null })).toContain("no frames yet");
  });
});

describe("runBufferCommand", () => {
  test("start sends options as query params with auth, and prints state plus a memory bound", async () => {
    const { d, calls, out, err } = deps({ "/buffer/start": json({ enabled: true, options: VIEW.options, startedAt: VIEW.origin }) });
    const code = await runBufferCommand("start", { seconds: "30", fps: "8", size: "480", quality: "0.5", maxMb: "16" }, d);
    expect(code).toBe(0);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://127.0.0.1:3400/helper/DEV/buffer/start?seconds=30&fps=8&size=480&quality=0.5&maxMB=16");
    expect(calls[0]!.headers.Authorization).toBe("Bearer T");
    expect(JSON.parse(out[0]!)).toMatchObject({ enabled: true });
    expect(err.join("\n")).toContain("serve-sim buffer stop");
  });

  test("server errors exit 1 with the message", async () => {
    const { d, err } = deps({ "/buffer/start": json({ error: "invalid_buffer_options", message: "seconds must be an integer 1..60" }, 400) });
    expect(await runBufferCommand("start", { seconds: "600" }, d)).toBe(1);
    expect(err[0]).toContain("seconds must be an integer 1..60");
  });

  test("an older server without the route says so", async () => {
    const { d, err } = deps({});
    expect(await runBufferCommand("status", {}, d)).toBe(1);
    expect(err[0]).toContain("does not support the rolling buffer");
  });

  test("unreachable server exits 1", async () => {
    const { d, err } = deps({}, { fetch: async () => { throw new Error("ECONNREFUSED"); } });
    expect(await runBufferCommand("stop", {}, d)).toBe(1);
    expect(err[0]).toContain("ECONNREFUSED");
  });

  test("auth refusals point at --auth-token", async () => {
    const { d, err } = deps({ "/buffer": () => new Response("{}", { status: 401 }) });
    expect(await runBufferCommand("list", {}, d)).toBe(1);
    expect(err[0]).toContain("--auth-token");
  });

  test("list passes --since and prints text, or JSON with --json", async () => {
    const { d, calls, out } = deps({ "/buffer": json(VIEW) });
    expect(await runBufferCommand("list", { since: "5s" }, d)).toBe(0);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3400/helper/DEV/buffer?since=5");
    expect(out.join("\n")).toContain("frame 2");
    const j = deps({ "/buffer": json(VIEW) });
    await runBufferCommand("list", { json: true }, j.d);
    expect(JSON.parse(j.out[0]!)).toEqual(VIEW);
    const bad = deps({ "/buffer": json(VIEW) });
    expect(await runBufferCommand("list", { since: "soon" }, bad.d)).toBe(1);
    expect(bad.calls).toEqual([]);
  });

  test("frame writes -o, pipes to stdout when not a TTY, else a temp file", async () => {
    const out1 = join(dir, "one.jpg");
    const a = deps({ "/buffer/frame": jpegRoute(2) });
    expect(await runBufferCommand("frame", { ago: "1.5", output: out1 }, a.d)).toBe(0);
    expect(a.calls[0]!.url).toBe("http://127.0.0.1:3400/helper/DEV/buffer/frame?ago=1.5");
    expect([...readFileSync(out1)]).toEqual([0xff, 0xd8, 2, 0xff, 0xd9]);

    const b = deps({ "/buffer/frame": jpegRoute(3) }, { stdoutIsTTY: false });
    expect(await runBufferCommand("frame", { id: "3" }, b.d)).toBe(0);
    expect(b.calls[0]!.url).toContain("frame?id=3");
    expect([...b.stdout[0]!]).toEqual([0xff, 0xd8, 3, 0xff, 0xd9]);

    const c = deps({ "/buffer/frame": jpegRoute(4) });
    expect(await runBufferCommand("frame", {}, c.d)).toBe(0);
    const written = c.out[0]!.match(/\S+\.jpg/)![0];
    expect(written.startsWith(dir)).toBe(true);
    expect(existsSync(written)).toBe(true);

    const both = deps({});
    expect(await runBufferCommand("frame", { id: "1", ago: "1" }, both.d)).toBe(1);
  });

  test("frame 404/409 explain the problem", async () => {
    const { d, err } = deps({ "/buffer/frame": json({ error: "buffer_off", message: "The rolling buffer is off" }, 409) });
    expect(await runBufferCommand("frame", {}, d)).toBe(1);
    expect(err[0]).toContain("rolling buffer is off");
  });

  test("dump writes every frame plus buffer.json with file names, outside the cwd by default", async () => {
    const { d, out, calls } = deps({ "/buffer": json(VIEW), "/buffer/frame": () => {
      const id = Number(new URL(calls.at(-1)!.url).searchParams.get("id"));
      return jpegRoute(id)();
    } });
    expect(await runBufferCommand("dump", {}, d)).toBe(0);
    const target = out.at(-1)!.match(/(\/\S+)$/)![1]!;
    expect(target.startsWith(dir)).toBe(true);
    expect(readdirSync(target).sort()).toEqual(["buffer.json", "frame-0001.jpg", "frame-0002.jpg"]);
    const index = JSON.parse(readFileSync(join(target, "buffer.json"), "utf8"));
    expect(index.frames.map((f: { file: string }) => f.file)).toEqual(["frame-0001.jpg", "frame-0002.jpg"]);
    expect(index.events[0].nextChange.frame).toBe(2);
    expect([...readFileSync(join(target, "frame-0002.jpg"))]).toEqual([0xff, 0xd8, 2, 0xff, 0xd9]);
  });

  test("dump -o uses that directory and refuses a non-empty one", async () => {
    const target = join(dir, "dump-here");
    const routes = { "/buffer": json(VIEW), "/buffer/frame": jpegRoute(1) };
    expect(await runBufferCommand("dump", { output: target }, deps(routes).d)).toBe(0);
    expect(existsSync(join(target, "buffer.json"))).toBe(true);
    const again = deps(routes);
    expect(await runBufferCommand("dump", { output: target }, again.d)).toBe(1);
    expect(again.err[0]).toContain("not empty");
  });

  test("dump of an off buffer fails", async () => {
    const { d, err } = deps({ "/buffer": json({ enabled: false }) });
    expect(await runBufferCommand("dump", {}, d)).toBe(1);
    expect(err[0]).toContain("off");
  });
});

describe("serve-sim buffer (CLI wiring)", () => {
  test("bare `buffer` is status; start/list reach the helper routes with --url, -d and the bearer token", async () => {
    const { spawn } = await import("child_process");
    const { createServer } = await import("http");
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
      const path = (req.url ?? "").split("?")[0];
      if (path === "/api") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ device: "DEV" }));
      if (path === "/helper/DEV/buffer") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(VIEW));
      if (path === "/helper/DEV/buffer/start") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ enabled: true, options: VIEW.options }));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const cli = join(import.meta.dir, "..", "index.ts");
    const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun) => {
      const env: NodeJS.ProcessEnv = { ...process.env, SERVE_SIM_AUTH_TOKEN: "TOK" };
      delete env.SERVE_SIM_URL;
      const child = spawn("bun", ["run", cli, "buffer", ...args, "--url", `http://127.0.0.1:${port}`, "-d", "DEV"], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolveRun({ status, stdout, stderr }));
    });
    try {
      const status = await run([]);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ enabled: true, options: { seconds: 20 } });
      const start = await run(["start", "--seconds", "30", "--max-mb", "8"]);
      expect(start.status).toBe(0);
      const list = await run(["list", "--since", "5s"]);
      expect(list.stdout).toContain("frame 2");
      expect(seen).toContain("POST /helper/DEV/buffer/start?seconds=30&maxMB=8 Bearer TOK");
      expect(seen).toContain("GET /helper/DEV/buffer?since=5 Bearer TOK");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe("serve-sim --buffer", () => {
  test("rejects a window outside 1-60 s before starting anything", async () => {
    const { spawnSync } = await import("child_process");
    const cli = join(import.meta.dir, "..", "index.ts");
    const r = spawnSync("bun", ["run", cli, "--buffer", "999", "--list"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--buffer expects a whole number of seconds from 1 to 60");
  }, 30_000);
});
