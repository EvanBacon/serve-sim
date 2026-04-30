import { readdirSync, readFileSync, existsSync, unlinkSync } from "fs";
import {
  execSync,
  spawn,
  exec,
  execFile,
  type ChildProcess,
} from "child_process";
import * as http from "node:http";
import type { Server } from "node:http";
import httpProxy from "http-proxy";
import { tmpdir } from "os";
import { join } from "path";

// Injected at build time as a base64-encoded string via `define`
declare const __PREVIEW_HTML_B64__: string;
const STATE_DIR = join(tmpdir(), "serve-sim");

interface ServeSimState {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

/**
 * Same-origin paths under `basePath` so the public preview URL (tunnel or reverse proxy) serves
 * `/…/stream.mjpeg` and `/…/ws` and this package proxies them to the helper.
 * `state.port` stays the real stream port for disk / CLI.
 */
export function previewPublicState(
  state: ServeSimState,
  basePath: string,
): ServeSimState {
  const base = basePath.replace(/\/+$/, "");
  const streamUrl = base ? `${base}/stream.mjpeg` : "/stream.mjpeg";
  const wsUrl = base ? `${base}/ws` : "/ws";
  return {
    ...state,
    url: base,
    streamUrl,
    wsUrl,
  };
}

function proxyHttpToHelper(
  port: number,
  upstreamPath: "/stream.mjpeg" | "/config",
  req: any,
  res: any,
) {
  const headers: http.OutgoingHttpHeaders = {};
  const accept = req.headers?.accept ?? req.headers?.Accept;
  if (accept) headers["Accept"] = accept as string;
  const clientUrl: string = req.url ?? "";
  const q = clientUrl.indexOf("?");
  const query = q === -1 ? "" : clientUrl.slice(q);
  const upstreamReqPath = upstreamPath + query;
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: upstreamReqPath,
      method: "GET",
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers as any);
      up.pipe(res);
      up.on("error", () => {
        try {
          res.destroy();
        } catch {}
      });
    },
  );
  upstream.on("error", () => {
    try {
      res.writeHead(502);
      res.end();
    } catch {}
  });
  upstream.end();
}

/**
 * Forward browser `WebSocket` on `{basePath}/ws` to the Swift helper when
 * using tunnel mode (`previewHostname`). Call once on your HTTP `Server`:
 * `attachServeSimTunnelWsProxy(httpServer, { basePath: "/.sim", previewHostname: "…" })`.
 */
export function attachServeSimTunnelWsProxy(
  server: Server,
  options: Pick<SimMiddlewareOptions, "basePath" | "previewHostname">,
): void {
  const base = (options.basePath ?? "/.sim").replace(/\/+$/, "");
  if (!options.previewHostname?.trim()) return;
  const wsPath = `${base}/ws`;

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== wsPath) return;
    const states = readServeSimStates();
    const st = states[0];
    if (!st) {
      socket.destroy();
      return;
    }
    const proxy = httpProxy.createProxyServer({
      target: `http://127.0.0.1:${st.port}`,
      ws: true,
    });
    proxy.ws(req, socket, head);
    proxy.on("error", () => {
      try {
        socket.destroy();
      } catch {}
    });
  });
}

// Known bundle IDs that are always React Native shells (used as a fallback
// before the app-container path resolves, since simctl can lag after launch).
const RN_BUNDLE_IDS = new Set<string>([
  "host.exp.Exponent", // Expo Go (App Store)
  "dev.expo.Exponent", // Expo Go dev builds
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
const NON_UI_BUNDLE_RE =
  /(WidgetRenderer|ExtensionHost|\.extension(\.|$)|Service|PlaceholderApp|InCallService|CallUI|InCallUI|com\.apple\.Preferences\.Cellular|com\.apple\.purplebuddy|com\.apple\.chrono|com\.apple\.shuttle|com\.apple\.usernotificationsui)/i;

function isUserFacingBundle(bundleId: string): boolean {
  return !NON_UI_BUNDLE_RE.test(bundleId);
}

function detectReactNative(udid: string, bundleId: string): Promise<boolean> {
  if (RN_BUNDLE_IDS.has(bundleId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile(
      "xcrun",
      ["simctl", "get_app_container", udid, bundleId, "app"],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) return resolve(false);
        const appPath = stdout.trim();
        if (!appPath) return resolve(false);
        for (const marker of RN_MARKERS) {
          if (existsSync(join(appPath, marker))) return resolve(true);
        }
        resolve(false);
      },
    );
  });
}

// Cache simctl's booted-device set briefly so per-request cost stays bounded.
// The middleware runs inside the user's dev server (Metro etc.) and
// readServeSimStates() is called on every /api and every page load.
let bootedSnapshot: { at: number; booted: Set<string> | null } = {
  at: 0,
  booted: null,
};
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
        try {
          unlinkSync(path);
        } catch {}
        continue;
      }
      // Helper alive but its simulator was shut down — the MJPEG stream
      // would accept connections yet never produce frames, leaving the
      // preview stuck on "Connecting...". Recycle the stale state so the
      // caller can spawn a fresh helper bound to whatever is booted.
      if (booted && !booted.has(state.device)) {
        try {
          process.kill(state.pid, "SIGTERM");
        } catch {}
        try {
          unlinkSync(path);
        } catch {}
        continue;
      }
      states.push(state);
    } catch {}
  }
  return states;
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
  /**
   * Tunnel mode: inject same-origin `streamUrl` / `wsUrl` / `url` under
   * `basePath`, and proxy those HTTP paths (plus WebSocket `{basePath}/ws`
   * via {@link attachServeSimTunnelWsProxy}) to the helper on 127.0.0.1.
   */
  previewHostname?: string;
  /** Reserved (tunnel URLs are path-based). */
  previewTls?: boolean;
}

/**
 * Connect-style middleware that serves the simulator preview UI.
 *
 * Routes handled under `basePath` (default `/.sim`):
 *   GET  {basePath}         — the preview HTML page
 *   GET  {basePath}/api     — serve-sim state JSON
 *   GET  {basePath}/logs    — SSE stream of simctl logs
 */
export function simMiddleware(options?: SimMiddlewareOptions) {
  const base = (options?.basePath ?? "/.sim").replace(/\/+$/, "");
  const previewHost = options?.previewHostname?.trim();

  return (req: any, res: any, next?: () => void) => {
    const rawUrl: string = req.url ?? "";
    const qIndex = rawUrl.indexOf("?");
    const url = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);

    // Tunnel mode: proxy MJPEG + JSON config to the Swift helper (same paths as on the helper).
    if (
      previewHost &&
      req.method === "GET" &&
      (url === base + "/stream.mjpeg" || url === base + "/config")
    ) {
      const states = readServeSimStates();
      const st = states[0];
      if (!st) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      const upstreamPath: "/stream.mjpeg" | "/config" = url.endsWith("/config")
        ? "/config"
        : "/stream.mjpeg";
      proxyHttpToHelper(st.port, upstreamPath, req, res);
      return;
    }

    // Serve the preview page
    if (url === base || url === base + "/") {
      const states = readServeSimStates();
      const state = states[0] ?? null;
      let html = loadHtml();

      if (state) {
        // Pass real serve-sim URLs directly. The client parses the MJPEG
        // stream via fetch() (CORS is fine — serve-sim sends Access-Control-Allow-Origin: *)
        // and connects to the WS directly (WS has no CORS).
        const previewState = previewHost
          ? previewPublicState(state, base)
          : state;

        const config = JSON.stringify({
          ...previewState,
          logsEndpoint: base + "/logs",
          ...(previewHost ? { proxiedPreview: true } : {}),
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
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(states[0] || null));
      return;
    }

    // POST /exec — run a shell command on the host. The preview server binds
    // to localhost only and is meant for local dev, so we shell through
    // /bin/sh and return stdout/stderr/exitCode.
    if (
      (url === base + "/exec" || url === base + "/exec/") &&
      req.method === "POST"
    ) {
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
          res.end(
            JSON.stringify({
              stdout: "",
              stderr: "Missing command",
              exitCode: 1,
            }),
          );
          return;
        }
        exec(
          command,
          { maxBuffer: 16 * 1024 * 1024 },
          (err, stdout, stderr) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                stdout: stdout.toString(),
                stderr: stderr.toString(),
                exitCode: err ? ((err as any).code ?? 1) : 0,
              }),
            );
          },
        );
      });
      return;
    }

    // SSE: simctl log stream
    if (url === base + "/logs") {
      const states = readServeSimStates();
      if (states.length === 0) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      const udid = states[0].device;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");

      const child: ChildProcess = spawn(
        "xcrun",
        [
          "simctl",
          "spawn",
          udid,
          "log",
          "stream",
          "--style",
          "ndjson",
          "--level",
          "info",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );

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
      if (states.length === 0) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      const udid = states[0].device;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");

      const child: ChildProcess = spawn(
        "xcrun",
        [
          "simctl",
          "spawn",
          udid,
          "log",
          "stream",
          "--style",
          "ndjson",
          "--level",
          "info",
          "--predicate",
          'process == "SpringBoard" AND eventMessage CONTAINS "Setting process visibility to: Foreground"',
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );

      // e.g. "[app<com.apple.mobilesafari>:43117] Setting process visibility to: Foreground"
      const FG_RE =
        /\[app<([^>]+)>:(\d+)\] Setting process visibility to: Foreground/;
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
          try {
            msg = JSON.parse(line).eventMessage ?? "";
          } catch {
            continue;
          }
          const m = FG_RE.exec(msg);
          if (!m) continue;
          const bundleId = m[1]!;
          const pid = parseInt(m[2]!, 10);
          if (!isUserFacingBundle(bundleId)) continue;
          if (bundleId === lastBundle) continue;
          lastBundle = bundleId;
          detectReactNative(udid, bundleId).then((isReactNative) => {
            res.write(
              "data: " +
                JSON.stringify({ bundleId, pid, isReactNative }) +
                "\n\n",
            );
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
