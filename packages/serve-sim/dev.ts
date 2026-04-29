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

function readServeSimStates() {
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter(
      (f) => f.startsWith("server-") && f.endsWith(".json"),
    );
  } catch {
    return [];
  }
  const booted = getBootedUdids();
  const states: any[] = [];
  for (const f of files) {
    const path = join(STATE_DIR, f);
    try {
      const state = JSON.parse(readFileSync(path, "utf-8"));
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

// ─── Client bundler with watch ───

let clientJs = "";
let clientError = "";
const reloadClients = new Set<ReadableStreamDefaultController>();

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
    clientJs = (await result.outputs[0].text()).replace(/<\/script>/gi, "<\\/script>");
    clientError = "";
    const ms = (performance.now() - start).toFixed(0);
    console.log(`\x1b[32m✓\x1b[0m Bundled client.tsx (${(clientJs.length / 1024).toFixed(0)} KB) in ${ms}ms`);
  } else {
    clientError = result.logs.map((l) => String(l)).join("\n");
    console.error("\x1b[31m✗\x1b[0m Build failed:\n" + clientError);
  }
  // Signal connected browsers to reload
  for (const ctrl of reloadClients) {
    try {
      ctrl.enqueue("data: reload\n\n");
    } catch {
      reloadClients.delete(ctrl);
    }
  }
}

// Initial build
await buildClient();

// Watch src/client/ for changes and rebuild
watch(CLIENT_DIR, { recursive: true }, (_event, filename) => {
  if (filename && /\.(tsx?|css)$/.test(filename)) {
    buildClient();
  }
});

// ─── HTML shell ───

function buildHtml(): string {
  const states = readServeSimStates();
  const state = states[0] ?? null;
  const configScript = state
    ? `<script>window.__SIM_PREVIEW__=${JSON.stringify({ ...state, logsEndpoint: "/logs" })}</script>`
    : "";

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>serve-sim dev</title>
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}</style>
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
      return Response.json(states[0] ?? null, {
        headers: { "Cache-Control": "no-store" },
      });
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
      if (states.length === 0) {
        return new Response("No serve-sim device", { status: 404 });
      }
      const udid = states[0].device;
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
      if (states.length === 0) {
        return new Response("No serve-sim device", { status: 404 });
      }
      const udid = states[0].device;
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
    return new Response(buildHtml(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  },
});

console.log(`\n  \x1b[36mserve-sim dev\x1b[0m  http://localhost:${PORT}\n`);
