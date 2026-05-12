#!/usr/bin/env bun
/**
 * Dev server for the serve-sim preview UI (the same client that ships inlined
 * in `serve-sim`). Iterate on src/client/ with live rebuild.
 *
 * Run: bun --watch dev.ts
 */
import { readdirSync, readFileSync, existsSync, unlinkSync, watch } from "fs";
import { execSync, spawn, exec, execFile, type ChildProcess } from "child_process";
import { tmpdir } from "os";
import { join, resolve } from "path";
import tailwindPlugin from "bun-plugin-tailwind";
import { createAxStreamerCache } from "./src/ax";

const RN_BUNDLE_IDS = new Set<string>([
  "host.exp.Exponent",
  "dev.expo.Exponent",
]);
const RN_MARKERS = [
  "Frameworks/React.framework",
  "Frameworks/hermes.framework",
  "Frameworks/Hermes.framework",
  "Frameworks/ExpoModulesCore.framework",
  "main.jsbundle",
];
function detectReactNative(udid: string, bundleId: string): Promise<boolean> {
  if (RN_BUNDLE_IDS.has(bundleId)) return Promise.resolve(true);
  return new Promise((r) => {
    execFile("xcrun", ["simctl", "get_app_container", udid, bundleId, "app"],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) return r(false);
        const appPath = stdout.trim();
        if (!appPath) return r(false);
        for (const m of RN_MARKERS) if (existsSync(join(appPath, m))) return r(true);
        r(false);
      });
  });
}
const NON_UI_BUNDLE_RE = /(WidgetRenderer|ExtensionHost|\.extension(\.|$)|Service|PlaceholderApp|InCallService|CallUI|InCallUI|com\.apple\.Preferences\.Cellular|com\.apple\.purplebuddy|com\.apple\.chrono|com\.apple\.shuttle|com\.apple\.usernotificationsui)/i;
function isUserFacingBundle(bundleId: string): boolean {
  return !NON_UI_BUNDLE_RE.test(bundleId);
}

const PORT = Number(process.env.PORT) || 3200;
const STATE_DIR = join(tmpdir(), "serve-sim");
const CLIENT_DIR = resolve(import.meta.dir, "src/client");
const CLIENT_ENTRY = resolve(CLIENT_DIR, "client.tsx");
const PKG_ROOT = resolve(import.meta.dir);
const SERVE_SIM_BIN_CANDIDATES = [
  join(PKG_ROOT, "src", "index.ts"),
  join(PKG_ROOT, "dist", "serve-sim.js"),
];
function resolveServeSimBin(): string {
  for (const p of SERVE_SIM_BIN_CANDIDATES) if (existsSync(p)) return p;
  return "serve-sim";
}
const SERVE_SIM_BIN = resolveServeSimBin();
const axStreamerCache = createAxStreamerCache();

type ServeSimState = {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
};

// ─── Serve-sim state ───

// Cache simctl's booted-device set briefly (1.5s). dev.ts calls
// readServeSimStates() on every request, so uncached we'd invoke simctl
// per page view / per /logs / per /appstate.
let bootedSnapshot: { at: number; booted: Set<string> | null } = { at: 0, booted: null };
function getBootedUdids(): Set<string> | null {
  const now = Date.now();
  if (bootedSnapshot.booted && now - bootedSnapshot.at < 1500) {
    return bootedSnapshot.booted;
  }
  try {
    const output = execSync("xcrun simctl list devices booted -j", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3_000,
    });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    const booted = new Set<string>();
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.state === "Booted") booted.add(device.udid);
      }
    }
    bootedSnapshot = { at: now, booted };
    return booted;
  } catch {
    return null;
  }
}

function readServeSimStates(): ServeSimState[] {
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter(
      (f) => f.startsWith("server-") && f.endsWith(".json"),
    );
  } catch {
    return [];
  }
  const booted = getBootedUdids();
  const states: ServeSimState[] = [];
  for (const f of files) {
    const path = join(STATE_DIR, f);
    try {
      const state = JSON.parse(readFileSync(path, "utf-8")) as ServeSimState;
      try {
        process.kill(state.pid, 0);
      } catch {
        try { unlinkSync(path); } catch {}
        continue;
      }
      // Helper alive but bound to a shutdown simulator — the Swift helper
      // keeps accepting MJPEG connections and /health returns OK, but no
      // frames ever flow. Recycle so a fresh helper is spawned on demand.
      if (booted && !booted.has(state.device)) {
        console.error(
          `\x1b[33m[serve-sim] Recycling stale helper pid ${state.pid} — device ${state.device} is no longer booted.\x1b[0m`,
        );
        try { process.kill(state.pid, "SIGTERM"); } catch {}
        try { unlinkSync(path); } catch {}
        continue;
      }
      states.push(state);
    } catch {}
  }
  return states;
}

function selectServeSimState(
  states: ServeSimState[],
  device?: string | null,
): ServeSimState | null {
  if (device) return states.find((state) => state.device === device) ?? null;
  return states[0] ?? null;
}

function endpoint(path: string, device: string): string {
  return `/${path}?device=${encodeURIComponent(device)}`;
}

function previewConfigForState(state: ServeSimState) {
  return {
    ...state,
    basePath: "/",
    logsEndpoint: endpoint("logs", state.device),
    appStateEndpoint: endpoint("appstate", state.device),
    axEndpoint: endpoint("ax", state.device),
    serveSimBin: SERVE_SIM_BIN,
  };
}

// ─── Client bundler with watch ───

let clientJs = "";
let clientError = "";
let tailwindCss = "";
const reloadClients = new Set<ReadableStreamDefaultController>();
let lastTailwindContentSignature = "";
let pendingClientBuild = false;
let pendingTailwindBuild = false;
let buildTimer: ReturnType<typeof setTimeout> | null = null;

function signalReload() {
  for (const ctrl of reloadClients) {
    try {
      ctrl.enqueue("data: reload\n\n");
    } catch {
      reloadClients.delete(ctrl);
    }
  }
}

async function buildClient() {
  const start = performance.now();
  const result = await Bun.build({
    entrypoints: [CLIENT_ENTRY],
    minify: false,
    target: "browser",
    format: "esm",
    define: {
      "process.env.NODE_ENV": '"development"',
    },
  });
  if (result.success) {
    clientJs = (await result.outputs[0]!.text()).replace(/<\/script>/gi, "<\\/script>");
    clientError = "";
    const ms = (performance.now() - start).toFixed(0);
    console.log(`\x1b[32m✓\x1b[0m Bundled client.tsx (${(clientJs.length / 1024).toFixed(0)} KB) in ${ms}ms`);
  } else {
    clientError = result.logs.map((l) => String(l)).join("\n");
    console.error("\x1b[31m✗\x1b[0m Build failed:\n" + clientError);
  }
  signalReload();
}

function cssCommentEscape(value: string): string {
  return value
    .replace(/\*\//g, "* /")
    .replace(/</g, "\\3C ");
}

async function buildTailwindCss() {
  const start = performance.now();
  try {
    const result = await Bun.build({
      entrypoints: [resolve(CLIENT_DIR, "global.css")],
      minify: false,
      plugins: [tailwindPlugin],
    });
    if (result.success) {
      tailwindCss = await result.outputs[0]!.text();
      const ms = (performance.now() - start).toFixed(0);
      console.log(`\x1b[32m✓\x1b[0m Bundled global.css (${(tailwindCss.length / 1024).toFixed(0)} KB) in ${ms}ms`);
    } else {
      const err = result.logs.map((l) => String(l)).join("\n");
      console.error("\x1b[31m✗\x1b[0m Tailwind build failed:\n" + err);
      tailwindCss = `/* tailwind build failed: ${cssCommentEscape(err)} */`;
    }
  } catch (e) {
    console.error("\x1b[31m✗\x1b[0m Tailwind build threw:", e);
    tailwindCss = `/* tailwind build threw: ${cssCommentEscape(String(e))} */`;
  }
  signalReload();
}

await Promise.all([buildClient(), buildTailwindCss()]);
lastTailwindContentSignature = readTailwindContentSignature();

watch(CLIENT_DIR, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  const name = String(filename);
  if (!/\.(tsx?|css)$/.test(name)) return;
  if (/\.tsx?$/.test(name)) pendingClientBuild = true;
  if (/\.css$/.test(name)) pendingTailwindBuild = true;
  scheduleWatchedBuild();
});

function listClientFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listClientFiles(path));
    } else if (/\.(tsx?|jsx?|css)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}

function readTailwindContentSignature(): string {
  const parts: string[] = [];
  for (const path of listClientFiles(CLIENT_DIR)) {
    const text = readFileSync(path, "utf-8");
    if (/\.css$/.test(path)) {
      parts.push(path, text);
      continue;
    }
    const stringLiterals = text.match(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g) ?? [];
    parts.push(path, stringLiterals.join("\n"));
  }
  return parts.join("\n");
}

function tailwindContentChanged(): boolean {
  const next = readTailwindContentSignature();
  if (next === lastTailwindContentSignature) return false;
  lastTailwindContentSignature = next;
  return true;
}

function scheduleWatchedBuild() {
  if (buildTimer) clearTimeout(buildTimer);
  buildTimer = setTimeout(() => {
    buildTimer = null;
    const shouldBuildClient = pendingClientBuild;
    const contentChanged = tailwindContentChanged();
    const shouldBuildTailwind =
      pendingTailwindBuild || (pendingClientBuild && contentChanged);
    pendingClientBuild = false;
    pendingTailwindBuild = false;
    if (shouldBuildClient) void buildClient();
    if (shouldBuildTailwind) void buildTailwindCss();
  }, 75);
}

// ─── HTML shell ───

function buildHtml(selectedDevice?: string | null): string {
  const states = readServeSimStates();
  const state = selectServeSimState(states, selectedDevice);
  const configScript = state
    ? `<script>window.__SIM_PREVIEW__=${JSON.stringify(previewConfigForState(state))}</script>`
    : "";

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>serve-sim dev</title>
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}</style>
<style>${tailwindCss}</style>
</head><body>
<div id="root"></div>
${configScript}
<script type="module">${clientJs}</script>
<script>
// Auto-reload on rebuild
const es = new EventSource("/__dev/reload");
es.onmessage = (e) => { if (e.data === "reload") location.reload(); };
</script>
${clientError ? `<pre style="position:fixed;inset:0;z-index:9999;background:#1a0000;color:#ff6b6b;padding:24px;margin:0;font-size:13px;overflow:auto;white-space:pre-wrap">${clientError.replace(/</g, "&lt;")}</pre>` : ""}
</body></html>`;
}

// ─── Server ───

Bun.serve({
  port: PORT,
  idleTimeout: 255, // SSE / MJPEG streams are long-lived
  fetch(req) {
    const url = new URL(req.url);
    const selectedDevice = url.searchParams.get("device");

    // Dev reload SSE
    if (url.pathname === "/__dev/reload") {
      const stream = new ReadableStream({
        start(controller) {
          reloadClients.add(controller);
          controller.enqueue(":\n\n");
        },
        cancel(controller) {
          reloadClients.delete(controller);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Serve-sim state API
    if (url.pathname === "/api") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      return Response.json(state ? previewConfigForState(state) : null, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/ax") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        return new Response("No serve-sim device", { status: 404 });
      }
      const ax = axStreamerCache.get(state.device, state.port);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(":\n\n");
          const removeClient = ax.addClient({
            write(chunk: string) {
              controller.enqueue(chunk);
            },
          });
          req.signal.addEventListener("abort", removeClient);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    if (url.pathname === "/grid/api/start" && req.method === "POST") {
      return req.json().then((body: any) => {
        const udid: string = body?.udid ?? "";
        if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(udid)) {
          return Response.json({ ok: false, error: "Invalid or missing udid" }, { status: 400 });
        }
        return new Promise<Response>((resolve) => {
          const child = spawn("bun", [SERVE_SIM_BIN, "--detach", udid], {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
          });
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
          child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
          const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 180_000);
          child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) {
              resolve(Response.json({ ok: true, stdout: stdout.trim() }));
            } else {
              resolve(Response.json({
                ok: false,
                error: stderr.trim() || stdout.trim() || `serve-sim exited with code ${code}`,
              }, { status: 500 }));
            }
          });
        });
      });
    }

    if (url.pathname === "/grid/api/shutdown" && req.method === "POST") {
      return req.json().then((body: any) => {
        const udid: string = body?.udid ?? "";
        if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(udid)) {
          return Response.json({ ok: false, error: "Invalid or missing udid" }, { status: 400 });
        }
        bootedSnapshot = { at: 0, booted: null };
        return new Promise<Response>((resolve) => {
          execFile("xcrun", ["simctl", "shutdown", udid], { timeout: 30_000 }, (err, _stdout, stderr) => {
            if (err) {
              resolve(Response.json({
                ok: false,
                error: stderr?.toString().trim() || err.message,
              }, { status: 500 }));
            } else {
              resolve(Response.json({ ok: true }));
            }
          });
        });
      });
    }

    if (url.pathname.startsWith("/grid/api/")) {
      return Response.json({ ok: false, error: `Unknown dev endpoint: ${url.pathname}` }, { status: 404 });
    }

    // POST /exec — run a shell command and return stdout/stderr/exitCode.
    if (url.pathname === "/exec" && req.method === "POST") {
      return req.json().then((body: any) => {
        const command: string = body?.command ?? "";
        if (!command) {
          return Response.json({ stdout: "", stderr: "Missing command", exitCode: 1 }, { status: 400 });
        }
        return new Promise<Response>((resolve) => {
          exec(command, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve(Response.json({
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              exitCode: err ? (err as any).code ?? 1 : 0,
            }));
          });
        });
      });
    }

    // SSE logs
    if (url.pathname === "/logs") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        return new Response("No serve-sim device", { status: 404 });
      }
      const udid = state.device;
      const stream = new ReadableStream({
        start(controller) {
          const child: ChildProcess = spawn("xcrun", [
            "simctl", "spawn", udid, "log", "stream",
            "--style", "ndjson", "--level", "info",
          ], { stdio: ["ignore", "pipe", "ignore"] });

          let buf = "";
          child.stdout!.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (line) {
                try {
                  controller.enqueue(`data: ${line}\n\n`);
                } catch {
                  child.kill();
                }
              }
            }
          });
          child.on("close", () => {
            try { controller.close(); } catch {}
          });
          // Clean up when client disconnects
          req.signal.addEventListener("abort", () => child.kill());
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // SSE foreground-app changes (filtered in the CLI; browser just listens).
    if (url.pathname === "/appstate") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        return new Response("No serve-sim device", { status: 404 });
      }
      const udid = state.device;
      const stream = new ReadableStream({
        start(controller) {
          const child: ChildProcess = spawn("xcrun", [
            "simctl", "spawn", udid, "log", "stream",
            "--style", "ndjson", "--level", "info",
            "--predicate",
            'process == "SpringBoard" AND eventMessage CONTAINS "Setting process visibility to: Foreground"',
          ], { stdio: ["ignore", "pipe", "ignore"] });
          const FG_RE = /\[app<([^>]+)>:(\d+)\] Setting process visibility to: Foreground/;
          let lastBundle = "";
          let buf = "";
          child.stdout!.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              let msg: string;
              try { msg = JSON.parse(line).eventMessage ?? ""; } catch { continue; }
              const m = FG_RE.exec(msg);
              if (!m) continue;
              const bundleId = m[1]!;
              const pid = parseInt(m[2]!, 10);
              if (!isUserFacingBundle(bundleId)) continue;
              if (bundleId === lastBundle) continue;
              lastBundle = bundleId;
              detectReactNative(udid, bundleId).then((isReactNative) => {
                try {
                  controller.enqueue(`data: ${JSON.stringify({ bundleId, pid, isReactNative })}\n\n`);
                } catch {
                  child.kill();
                }
              });
            }
          });
          child.on("close", () => { try { controller.close(); } catch {} });
          req.signal.addEventListener("abort", () => child.kill());
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Serve the HTML page (fresh on every request — picks up state + rebuild)
    return new Response(buildHtml(selectedDevice), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  },
});

console.log(`\n  \x1b[36mserve-sim dev\x1b[0m  http://localhost:${PORT}\n`);
