import { readdirSync, readFileSync, existsSync, unlinkSync, statSync, createReadStream } from "fs";
import { execSync, spawn, exec, execFile, type ChildProcess } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { createAxStreamerCache } from "./ax";
import {
  createAnnotation,
  deleteAllAnnotations,
  deleteAnnotation,
  getAnnotation,
  listAnnotations,
  resolveAnnotationAsset,
  updateAnnotation,
} from "./annotations";
import type {
  AnnotationCreateRequest,
  AnnotationUpdateRequest,
} from "./annotations-shared";

// Injected at build time as a base64-encoded string via `define`
declare const __PREVIEW_HTML_B64__: string;
const STATE_DIR = join(tmpdir(), "serve-sim");

export interface ServeSimState {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

const axStreamerCache = createAxStreamerCache();

// Known bundle IDs that are always React Native shells (used as a fallback
// before the app-container path resolves, since simctl can lag after launch).
const RN_BUNDLE_IDS = new Set<string>([
  "host.exp.Exponent",       // Expo Go (App Store)
  "dev.expo.Exponent",       // Expo Go dev builds
]);

const RN_MARKERS = [
  "Frameworks/React.framework",
  "Frameworks/hermes.framework",
  "Frameworks/Hermes.framework",
  "Frameworks/ExpoModulesCore.framework",
  "main.jsbundle",
];

// Processes that SpringBoard logs as "Foreground" but are not the visible
// user-facing app — widgets, extensions, background services. Emitting
// these to the client causes the app indicator to flicker as the user
// actually-foreground app switches mid-launch.
const NON_UI_BUNDLE_RE = /(WidgetRenderer|ExtensionHost|\.extension(\.|$)|Service|PlaceholderApp|InCallService|CallUI|InCallUI|com\.apple\.Preferences\.Cellular|com\.apple\.purplebuddy|com\.apple\.chrono|com\.apple\.shuttle|com\.apple\.usernotificationsui)/i;

function isUserFacingBundle(bundleId: string): boolean {
  return !NON_UI_BUNDLE_RE.test(bundleId);
}

function detectReactNative(udid: string, bundleId: string): Promise<boolean> {
  if (RN_BUNDLE_IDS.has(bundleId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile("xcrun", ["simctl", "get_app_container", udid, bundleId, "app"],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) return resolve(false);
        const appPath = stdout.trim();
        if (!appPath) return resolve(false);
        for (const marker of RN_MARKERS) {
          if (existsSync(join(appPath, marker))) return resolve(true);
        }
        resolve(false);
      });
  });
}

// Cache simctl's booted-device set briefly so per-request cost stays bounded.
// The middleware runs inside the user's dev server (Metro etc.) and
// readServeSimStates() is called on every /api and every page load.
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
      const state: ServeSimState = JSON.parse(readFileSync(path, "utf-8"));
      try {
        process.kill(state.pid, 0);
      } catch {
        try { unlinkSync(path); } catch {}
        continue;
      }
      // Helper alive but its simulator was shut down — the MJPEG stream
      // would accept connections yet never produce frames, leaving the
      // preview stuck on "Connecting...". Recycle the stale state so the
      // caller can spawn a fresh helper bound to whatever is booted.
      if (booted && !booted.has(state.device)) {
        try { process.kill(state.pid, "SIGTERM"); } catch {}
        try { unlinkSync(path); } catch {}
        continue;
      }
      states.push(state);
    } catch {}
  }
  return states;
}

export function selectServeSimState(
  states: ServeSimState[],
  device?: string | null,
): ServeSimState | null {
  if (device) {
    return states.find((state) => state.device === device) ?? null;
  }
  return states[0] ?? null;
}

function queryDevice(rawUrl: string): string | null {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return null;
  return new URLSearchParams(rawUrl.slice(qIndex + 1)).get("device");
}

function endpoint(base: string, path: string, device: string): string {
  const value = `${base}${path}`;
  return `${value}?device=${encodeURIComponent(device)}`;
}

let _html: string | null = null;
function loadHtml(): string {
  if (!_html) {
    _html = Buffer.from(__PREVIEW_HTML_B64__, "base64").toString("utf-8");
  }
  return _html;
}

export interface SimMiddlewareOptions {
  /** Base path to serve the preview at. Default: "/.sim" */
  basePath?: string;
  /** Pin this preview server to a specific simulator UDID. */
  device?: string;
}

/**
 * Connect-style middleware that serves the simulator preview UI.
 *
 * Routes handled under `basePath` (default `/.sim`):
 *   GET  {basePath}         — the preview HTML page
 *   GET  {basePath}/api     — serve-sim state JSON
 *   GET  {basePath}/logs    — SSE stream of simctl logs
 *   GET  {basePath}/ax      — SSE stream of normalized accessibility snapshots
 */
export function simMiddleware(options?: SimMiddlewareOptions) {
  const base = (options?.basePath ?? "/.sim").replace(/\/+$/, "");

  return (req: any, res: any, next?: () => void) => {
    const rawUrl: string = req.url ?? "";
    const qIndex = rawUrl.indexOf("?");
    const url = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const selectedDevice = queryDevice(rawUrl) ?? options?.device ?? null;

    // Serve the preview page
    if (url === base || url === base + "/") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      let html = loadHtml();

      if (state) {
        // Pass real serve-sim URLs directly. The client parses the MJPEG
        // stream via fetch() (CORS is fine — serve-sim sends Access-Control-Allow-Origin: *)
        // and connects to the WS directly (WS has no CORS).
        const config = JSON.stringify({
          ...state,
          basePath: base,
          logsEndpoint: endpoint(base, "/logs", state.device),
          appStateEndpoint: endpoint(base, "/appstate", state.device),
          axEndpoint: endpoint(base, "/ax", state.device),
        });
        const configScript = `<script>window.__SIM_PREVIEW__=${config}</script>`;
        html = html.replace("<!--__SIM_PREVIEW_CONFIG__-->", configScript);
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    // JSON API: serve-sim state
    if (url === base + "/api") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(state || null));
      return;
    }

    // SSE: normalized accessibility snapshot stream
    if (url === base + "/ax") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");
      const ax = axStreamerCache.get(state.device);
      const removeClient = ax.addClient(res);
      req.on("close", removeClient);
      return;
    }

    // POST /exec — run a shell command on the host. The preview server binds
    // to localhost only and is meant for local dev, so we shell through
    // /bin/sh and return stdout/stderr/exitCode.
    if ((url === base + "/exec" || url === base + "/exec/") && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString();
      });
      req.on("end", () => {
        let command = "";
        try {
          command = JSON.parse(body).command ?? "";
        } catch {}
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ stdout: "", stderr: "Missing command", exitCode: 1 }));
          return;
        }
        exec(command, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: err ? (err as any).code ?? 1 : 0,
          }));
        });
      });
      return;
    }

    // SSE: simctl log stream
    if (url === base + "/logs") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      const udid = state.device;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");

      const child: ChildProcess = spawn("xcrun", [
        "simctl", "spawn", udid, "log", "stream",
        "--style", "ndjson",
        "--level", "info",
      ], { stdio: ["ignore", "pipe", "ignore"] });

      let buf = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) res.write("data: " + line + "\n\n");
        }
      });

      child.on("close", () => res.end());
      req.on("close", () => child.kill());
      return;
    }

    // SSE: foreground-app change stream. Emits `{bundleId, pid}` events
    // parsed from SpringBoard's "Setting process visibility to: Foreground"
    // log line. Filtering is done here (not in the browser) so the SSE stream
    // stays narrow and the client can listen without rate-limit concerns.
    if (url === base + "/appstate") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      const udid = state.device;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");

      const child: ChildProcess = spawn("xcrun", [
        "simctl", "spawn", udid, "log", "stream",
        "--style", "ndjson",
        "--level", "info",
        "--predicate",
        'process == "SpringBoard" AND eventMessage CONTAINS "Setting process visibility to: Foreground"',
      ], { stdio: ["ignore", "pipe", "ignore"] });

      // e.g. "[app<com.apple.mobilesafari>:43117] Setting process visibility to: Foreground"
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
            res.write("data: " + JSON.stringify({ bundleId, pid, isReactNative }) + "\n\n");
          });
        }
      });

      child.on("close", () => res.end());
      req.on("close", () => child.kill());
      return;
    }

    // ─── Annotations API ───
    if (url === base + "/api/annotations" || url.startsWith(base + "/api/annotations/")) {
      handleAnnotationsRequest(req, res, base, selectedDevice);
      return;
    }

    // Not ours — pass through
    if (next) next();
  };
}

// ─── Annotations route handlers ───

function readJsonBody(req: any): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    const MAX = 16 * 1024 * 1024; // 16MB safety ceiling — crops are ~30KB each
    req.on("data", (chunk: Buffer | string) => {
      const piece = typeof chunk === "string" ? chunk : chunk.toString();
      size += piece.length;
      if (size > MAX) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      body += piece;
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function jsonResponse(res: any, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

function pickAnnotationDevice(req: any, fallback: string | null): string | null {
  const rawUrl: string = req.url ?? "";
  const qIndex = rawUrl.indexOf("?");
  if (qIndex !== -1) {
    const device = new URLSearchParams(rawUrl.slice(qIndex + 1)).get("device");
    if (device) return device;
  }
  if (fallback) return fallback;
  // Last resort: pick the first running serve-sim helper.
  const states = readServeSimStates();
  return states[0]?.device ?? null;
}

function handleAnnotationsRequest(
  req: any,
  res: any,
  base: string,
  selectedDevice: string | null,
): void {
  const rawUrl: string = req.url ?? "";
  const qIndex = rawUrl.indexOf("?");
  const path = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const after = path.slice((base + "/api/annotations").length);
  const method: string = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // Collection: /api/annotations
  if (after === "" || after === "/") {
    if (method === "GET") {
      const udid = pickAnnotationDevice(req, selectedDevice);
      if (!udid) return jsonResponse(res, 200, []);
      return jsonResponse(res, 200, listAnnotations(udid));
    }
    if (method === "POST") {
      readJsonBody(req)
        .then((body) => {
          const udid = pickAnnotationDevice(req, selectedDevice);
          const create = body as AnnotationCreateRequest;
          if (udid && !create?.device?.udid) {
            create.device = {
              udid,
              name: create.device?.name ?? "",
            };
          }
          if (!create?.device?.udid) {
            return jsonResponse(res, 400, { error: "no device available" });
          }
          const result = createAnnotation(create);
          if ("error" in result) return jsonResponse(res, 400, result);
          jsonResponse(res, 201, result.annotation);
        })
        .catch((err) => jsonResponse(res, 400, { error: String(err?.message ?? err) }));
      return;
    }
    if (method === "DELETE") {
      const udid = pickAnnotationDevice(req, selectedDevice);
      if (!udid) return jsonResponse(res, 404, { error: "no device" });
      const removed = deleteAllAnnotations(udid);
      return jsonResponse(res, 200, { removed });
    }
    res.writeHead(405); res.end(); return;
  }

  // Item: /api/annotations/{id} or /api/annotations/{id}/crop|frame
  const itemMatch = /^\/([A-Za-z0-9_-]+)(?:\/(crop|frame))?$/.exec(after);
  if (!itemMatch) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const id = itemMatch[1]!;
  const sub = itemMatch[2];
  const udid = pickAnnotationDevice(req, selectedDevice);
  if (!udid) return jsonResponse(res, 404, { error: "no device" });

  if (sub === "crop" || sub === "frame") {
    if (method !== "GET") { res.writeHead(405); res.end(); return; }
    const annotation = getAnnotation(udid, id);
    if (!annotation) return jsonResponse(res, 404, { error: "not found" });
    const relPath = sub === "crop" ? annotation.screenshotPath : annotation.fullFramePath;
    if (!relPath) return jsonResponse(res, 404, { error: "asset missing" });
    const abs = resolveAnnotationAsset(udid, relPath);
    if (!abs) return jsonResponse(res, 404, { error: "file gone" });
    let size = 0;
    try { size = statSync(abs).size; } catch {}
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": String(size),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    createReadStream(abs).pipe(res);
    return;
  }

  if (method === "GET") {
    const annotation = getAnnotation(udid, id);
    if (!annotation) return jsonResponse(res, 404, { error: "not found" });
    return jsonResponse(res, 200, annotation);
  }
  if (method === "PATCH") {
    readJsonBody(req)
      .then((body) => {
        const updated = updateAnnotation(udid, id, body as AnnotationUpdateRequest);
        if (!updated) return jsonResponse(res, 404, { error: "not found" });
        jsonResponse(res, 200, updated);
      })
      .catch((err) => jsonResponse(res, 400, { error: String(err?.message ?? err) }));
    return;
  }
  if (method === "DELETE") {
    const ok = deleteAnnotation(udid, id);
    if (!ok) return jsonResponse(res, 404, { error: "not found" });
    return jsonResponse(res, 200, { id });
  }
  res.writeHead(405); res.end();
}
