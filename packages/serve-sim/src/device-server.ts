/**
 * Device-mode relay server.
 *
 * Bridges a browser to a physical iOS device that's being driven by
 * WebDriverAgent (see `wda.ts`). It deliberately mirrors the shape of the
 * native simulator helper's HTTP surface (`/stream.mjpeg`, `/config`,
 * `/health`) so the mental model is the same, but the simulator client UI is
 * heavily `simctl`-coupled (device lists, exec-on-host, WebKit devtools) and
 * none of that applies to a real device — so device mode ships its own focused,
 * self-contained viewer page at `/` instead.
 *
 *   GET  /             → minimal viewer (MJPEG <img> + pointer→/input)
 *   GET  /stream.mjpeg → reverse-proxy WDA's on-device MJPEG server
 *   POST /input        → JSON pointer event → WDA tap/drag/button
 *   GET  /config       → device logical window size + name
 *   GET  /health       → readiness probe
 *
 * Touch model: the viewer reports normalized 0..1 coordinates; we scale by the
 * device's logical window size (points) before handing off to WDA. A press that
 * doesn't move becomes a tap; a press that moves becomes a drag (so swipes and
 * scrolls work).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { get as httpGet } from "http";
import { debugDevice } from "./debug";
import type { WdaSession } from "./wda";

interface PointerEventBody {
  type: "tap" | "drag" | "button";
  /** Normalized 0..1 (tap + drag start). */
  x?: number;
  y?: number;
  /** Normalized 0..1 (drag end). */
  x2?: number;
  y2?: number;
  /** For type: "button" — e.g. "home". */
  name?: string;
}

export interface DeviceServer {
  url: string;
  stop(): Promise<void>;
}

/**
 * Start the relay server bound to `host:port`, driving `session`.
 *
 * `host` defaults to 127.0.0.1; pass "0.0.0.0" to expose on the LAN (the viewer
 * has no auth, so only do that on a trusted network).
 */
export async function startDeviceServer(opts: {
  session: WdaSession;
  port: number;
  host?: string;
}): Promise<DeviceServer> {
  const { session, port } = opts;
  const host = opts.host ?? "127.0.0.1";

  const server = createServer((req, res) => handle(req, res, session));
  // MJPEG is long-lived; disable the default socket/keep-alive timeouts.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function handle(req: IncomingMessage, res: ServerResponse, session: WdaSession): void {
  const url = (req.url ?? "/").split("?")[0];

  if (url === "/health") {
    return json(res, 200, { status: "ok", device: session.device.udid });
  }
  if (url === "/config") {
    const size = session.getWindowSize();
    return json(res, 200, {
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      orientation: "portrait",
      device: session.device.name,
      productType: session.device.productType,
      productVersion: session.device.productVersion,
    });
  }
  if (url === "/stream.mjpeg") {
    return proxyMjpeg(res, session);
  }
  if (url === "/input" && req.method === "POST") {
    return handleInput(req, res, session);
  }
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return void res.end(viewerHtml(session));
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

/** Reverse-proxy WDA's on-device MJPEG stream straight to the browser. */
function proxyMjpeg(res: ServerResponse, session: WdaSession): void {
  const upstream = httpGet(session.mjpegUrl, (up) => {
    const contentType =
      up.headers["content-type"] ?? "multipart/x-mixed-replace; boundary=--BoundaryString";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-store",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    up.pipe(res);
    res.on("close", () => up.destroy());
  });
  upstream.on("error", (err) => {
    debugDevice("mjpeg upstream error: %s", err.message);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("MJPEG upstream unavailable");
  });
}

function handleInput(req: IncomingMessage, res: ServerResponse, session: WdaSession): void {
  let raw = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    raw += chunk;
    if (raw.length > 4096) {
      // Pointer payloads are tiny; reject anything larger with a clear 413
      // before tearing down so the client gets a response, not a reset.
      tooLarge = true;
      json(res, 413, { error: "payload_too_large" });
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooLarge) return;
    let body: PointerEventBody;
    try {
      body = JSON.parse(raw) as PointerEventBody;
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    const size = session.getWindowSize();
    if (!size) return json(res, 503, { error: "no_window_size" });

    const toPoints = (n: number | undefined, axis: "x" | "y") =>
      clamp01(n ?? 0) * (axis === "x" ? size.width : size.height);

    void (async () => {
      try {
        if (body.type === "button") {
          await session.pressButton(body.name ?? "home");
        } else if (body.type === "drag") {
          await session.drag(
            toPoints(body.x, "x"),
            toPoints(body.y, "y"),
            toPoints(body.x2, "x"),
            toPoints(body.y2, "y"),
          );
        } else {
          await session.tap(toPoints(body.x, "x"), toPoints(body.y, "y"));
        }
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
  });
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache, no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

/** Minimal self-contained viewer: MJPEG <img> + pointer→/input bridge. */
function viewerHtml(session: WdaSession): string {
  const name = escapeHtml(session.device.name);
  const subtitle = escapeHtml(
    `${session.device.productType} · iOS ${session.device.productVersion}`,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<title>${name} · serve-sim</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0b0d; color: #e7e7ea;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 12px; padding: 16px; overflow: hidden; }
  header { text-align: center; }
  header h1 { margin: 0; font-size: 14px; font-weight: 600; }
  header p { margin: 2px 0 0; font-size: 11px; color: #8a8a90; }
  .stage { position: relative; flex: 0 1 auto; display: flex; }
  img#screen { max-height: calc(100vh - 120px); max-width: 100%;
    border-radius: 28px; box-shadow: 0 10px 40px rgba(0,0,0,.5);
    touch-action: none; user-select: none; -webkit-user-drag: none;
    background: #000; display: block; }
  .bar { display: flex; gap: 8px; }
  button { background: #1c1c22; color: #e7e7ea; border: 1px solid #2c2c34;
    border-radius: 8px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
  button:active { background: #2a2a32; }
  .status { font-size: 11px; color: #6f6f76; min-height: 14px; }
</style>
</head>
<body>
  <header>
    <h1>${name}</h1>
    <p>${subtitle}</p>
  </header>
  <div class="stage">
    <img id="screen" src="/stream.mjpeg" alt="device screen" draggable="false" />
  </div>
  <div class="bar">
    <button id="home">Home</button>
  </div>
  <div class="status" id="status"></div>
<script>
(function () {
  var img = document.getElementById("screen");
  var statusEl = document.getElementById("status");
  var MOVE_THRESHOLD = 0.02; // normalized; below this a press is a tap
  var start = null;

  function setStatus(t) { statusEl.textContent = t; }

  function norm(ev) {
    var r = img.getBoundingClientRect();
    var x = (ev.clientX - r.left) / r.width;
    var y = (ev.clientY - r.top) / r.height;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }

  function send(payload) {
    return fetch("/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(function () {});
  }

  img.addEventListener("pointerdown", function (ev) {
    ev.preventDefault();
    img.setPointerCapture(ev.pointerId);
    start = norm(ev);
  });
  img.addEventListener("pointerup", function (ev) {
    if (!start) return;
    var end = norm(ev);
    var dx = end.x - start.x, dy = end.y - start.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < MOVE_THRESHOLD) {
      send({ type: "tap", x: start.x, y: start.y });
      setStatus("tap " + start.x.toFixed(2) + ", " + start.y.toFixed(2));
    } else {
      send({ type: "drag", x: start.x, y: start.y, x2: end.x, y2: end.y });
      setStatus("drag → " + end.x.toFixed(2) + ", " + end.y.toFixed(2));
    }
    start = null;
  });
  img.addEventListener("pointercancel", function () { start = null; });
  img.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  document.getElementById("home").addEventListener("click", function () {
    send({ type: "button", name: "home" });
    setStatus("home");
  });

  img.addEventListener("error", function () { setStatus("stream disconnected — reconnecting…");
    setTimeout(function () { img.src = "/stream.mjpeg?" + Date.now(); }, 1000); });
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
