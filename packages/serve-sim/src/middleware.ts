import { readdirSync, readFileSync, existsSync, unlinkSync } from "fs";
import { execSync, spawn, exec, execFile, type ChildProcess } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { createServer as createNetServer } from "net";
import { createAxStreamerCache } from "./ax";

// Injected at build time as a base64-encoded string via `define`
declare const __PREVIEW_HTML_B64__: string;
const STATE_DIR = join(tmpdir(), "serve-sim");
const DEVTOOLS_FRONTEND_REV = "854a02be78c7ffea104cb523636efa991bef5c5b";
const INSPECT_WEBKIT_START_PORT = 9222;

type WebKitBridgeTarget = {
  id: string;
  title: string;
  url: string;
  type: string;
  appName?: string;
  bundleId?: string;
  inUseByOtherInspector?: boolean;
};

type WebKitBridge = {
  port: number;
  cdpUrl: string;
  listTargets(): Promise<WebKitBridgeTarget[]>;
  highlightTarget?(targetId: string, on: boolean): Promise<void>;
  releaseHighlight?(targetId?: string): void;
};

export interface ServeSimState {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

const axStreamerCache = createAxStreamerCache();
let inspectWebKitBridge: Promise<WebKitBridge> | null = null;

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

async function isLocalPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "localhost");
  });
}

async function existingInspectWebKitBridge(port: number): Promise<WebKitBridge | null> {
  const cdpUrl = `http://localhost:${port}`;
  try {
    const versionRes = await fetch(`${cdpUrl}/json/version`);
    if (!versionRes.ok) return null;
    const version = await versionRes.json() as { Browser?: string };
    if (version.Browser !== "Safari/inspect-webkit") return null;
    return {
      port,
      cdpUrl,
      async listTargets() {
        const listRes = await fetch(`${cdpUrl}/json/list`);
        const targets = await listRes.json() as Array<{
          id: string;
          title: string;
          url: string;
          type: string;
          description?: string;
        }>;
        return targets
          .filter((target) => target.id.startsWith("sim:"))
          .map((target) => ({
            id: target.id,
            title: target.title || target.url || "Untitled",
            url: /^https?:/i.test(target.url) ? target.url : "about:blank",
            type: target.type || "page",
            bundleId: target.description?.match(/\(([^)]+)\)/)?.[1],
          }));
      },
    };
  } catch {
    return null;
  }
}

async function ensureInspectWebKitBridge(): Promise<WebKitBridge> {
  if (inspectWebKitBridge) return inspectWebKitBridge;
  inspectWebKitBridge = (async () => {
    const { startCdpServer } = await import("inspect-webkit");
    for (let port = INSPECT_WEBKIT_START_PORT; port < INSPECT_WEBKIT_START_PORT + 50; port++) {
      if (!(await isLocalPortFree(port))) {
        const existing = await existingInspectWebKitBridge(port);
        if (existing) return existing;
        continue;
      }
      try {
        const server = await startCdpServer({ host: "localhost", port });
        return {
          port,
          cdpUrl: `http://localhost:${port}`,
          async listTargets() {
            return server.getTargets()
              .filter((target: any) => target.source?.kind === "simulator")
              .map((target: any) => ({
                id: target.targetId,
                title: target.title || target.appName || target.url || "Untitled",
                url: /^https?:/i.test(target.url) ? target.url : "about:blank",
                type: target.type || "page",
                appName: target.appName,
                bundleId: target.bundleId,
                inUseByOtherInspector: !!target.inUseByOtherInspector,
              }));
          },
          highlightTarget: server.highlightTarget?.bind(server),
          releaseHighlight: server.releaseHighlight?.bind(server),
        };
      } catch (err: any) {
        if (err?.code === "EADDRINUSE") {
          const existing = await existingInspectWebKitBridge(port);
          if (existing) return existing;
          continue;
        }
        throw err;
      }
    }
    throw new Error(`No available inspect-webkit port found in ${INSPECT_WEBKIT_START_PORT}-${INSPECT_WEBKIT_START_PORT + 49}`);
  })().catch((err) => {
    inspectWebKitBridge = null;
    throw err;
  });
  return inspectWebKitBridge;
}

function devtoolsFrontendUrl(frontendBase: string, cdpPort: number, targetId: string): string {
  const url = new URL(`${frontendBase}/inspector.html`, "http://serve-sim.local");
  url.searchParams.set("ws", `127.0.0.1:${cdpPort}/devtools/page/${targetId}`);
  return `${url.pathname}${url.search}`;
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
    const devtoolsFrontendBase = base === "/" ? "/devtools-frontend" : `${base}/devtools-frontend`;

    // Same-origin proxy for Chrome DevTools frontend assets. Loading the
    // appspot-hosted frontend directly works as a top-level tab, but is flaky
    // inside embedded browser iframes. Serving it from the preview origin keeps
    // the frontend's relative assets and CSP on the local page.
    if (url === devtoolsFrontendBase || url.startsWith(`${devtoolsFrontendBase}/`)) {
      (async () => {
        const assetPath = url === devtoolsFrontendBase
          ? "inspector.html"
          : url.slice(devtoolsFrontendBase.length + 1);
        try {
          const upstream = await fetch(
            `https://chrome-devtools-frontend.appspot.com/serve_rev/@${DEVTOOLS_FRONTEND_REV}/${assetPath}${qIndex === -1 ? "" : rawUrl.slice(qIndex)}`,
          );
          const headers: Record<string, string> = {
            "Cache-Control": "public, max-age=604800",
          };
          const contentType = upstream.headers.get("content-type");
          if (contentType) headers["Content-Type"] = contentType;
          res.writeHead(upstream.status, headers);
          res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(err instanceof Error ? err.message : "Failed to load DevTools frontend");
        }
      })();
      return;
    }

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
          devtoolsEndpoint: endpoint(base, "/devtools", state.device),
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

    // JSON API: start the inspect-webkit CDP bridge and list WebKit targets
    // for the selected simulator. The bridge itself serves /json/list and
    // /devtools/page/:id on localhost; the preview adds iframe-safe frontend
    // URLs so the browser UI can embed Chrome DevTools.
    if (url === base + "/devtools") {
      (async () => {
        const states = readServeSimStates();
        const state = selectServeSimState(states, selectedDevice);
        if (!state) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No serve-sim device" }));
          return;
        }
        try {
          const bridge = await ensureInspectWebKitBridge();
          const bridgeTargets = await bridge.listTargets();
          const targets = bridgeTargets.map((target) => ({
            ...target,
            webSocketDebuggerUrl: `ws://localhost:${bridge.port}/devtools/page/${encodeURIComponent(target.id)}`,
            devtoolsFrontendUrl: devtoolsFrontendUrl(devtoolsFrontendBase, bridge.port, target.id),
          }));
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({
            port: bridge.port,
            cdpUrl: bridge.cdpUrl,
            targets,
          }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: err instanceof Error ? err.message : "Failed to start inspect-webkit",
          }));
        }
      })();
      return;
    }

    // POST /devtools/release — drop hover-highlight CDP sessions so we don't
    // sit on a WIR slot when the picker is dismissed (or the tab is closed).
    // Optional body { targetId } releases just one; empty body releases all.
    if (url === base + "/devtools/release" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = body ? JSON.parse(body) as { targetId?: string } : {};
          const bridge = await ensureInspectWebKitBridge();
          bridge.releaseHighlight?.(parsed.targetId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: err instanceof Error ? err.message : "Failed to release",
          }));
        }
      });
      return;
    }

    // POST /devtools/highlight — flash an inspectable target in the
    // simulator the way Safari's Develop menu hover does. Body shape:
    // { targetId: string, on: boolean }.
    if (url === base + "/devtools/highlight" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { targetId, on } = JSON.parse(body || "{}") as { targetId?: string; on?: boolean };
          if (!targetId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing targetId" }));
            return;
          }
          const bridge = await ensureInspectWebKitBridge();
          if (!bridge.highlightTarget) {
            res.writeHead(501, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "highlightTarget not supported by inspect-webkit" }));
            return;
          }
          await bridge.highlightTarget(targetId, !!on);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: err instanceof Error ? err.message : "Failed to highlight target",
          }));
        }
      });
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

    // Not ours — pass through
    if (next) next();
  };
}
