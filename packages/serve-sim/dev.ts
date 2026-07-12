#!/usr/bin/env bun
/**
 * Dev server for the serve-sim preview UI (the same client that ships inlined
 * in `serve-sim`). Iterate on src/client/ with live rebuild.
 *
 * Run: bun --watch dev.ts
 *
 * The whole host surface — the exec control socket, devtools, grid/device
 * list, and every SSE side-channel (`/logs`, `/appstate`, `/ax`,
 * `/api/events`) — is served by the production `simMiddleware`, mounted on a
 * Node `http` server exactly like `servePreview` does. This file only layers
 * on the dev-only concerns:
 *   • live client/CSS bundling + watch
 *   • the HTML shell that injects the freshly-bundled code
 *   • `/__dev/reload` (browser auto-reload on rebuild)
 *   • `/grid/api/start` re-pointed at the local source instead of the
 *     published `serve-sim` the middleware would otherwise resolve.
 */
import { readdirSync, readFileSync, existsSync, watch } from "fs";
import { randomBytes } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { Socket } from "net";
import { join, resolve } from "path";
import tailwindPlugin from "bun-plugin-tailwind";
import {
  simMiddleware,
  previewConfigForState,
  selectServeSimState,
  readServeSimStates,
  type ServeSimState,
} from "./src/middleware";
import { servePreview } from "./src/runtime";

const PORT = Number(process.env.PORT) || 3200;
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

// The in-page UI routes host requests (shell exec, simulator settings, SSE
// side-channels) through one `/exec-ws` control socket, authenticated with
// this per-process token (injected into the page config + the middleware).
const EXEC_TOKEN = randomBytes(32).toString("base64url");

// The same connect-style middleware production runs. `basePath: "/"` normalizes
// to an empty base internally, matching the `previewConfigForState(state, "")`
// endpoints we inject into the dev HTML shell below.
// The dev server owns its HTTP server and forwards upgrades (below), so it
// proxies helper/DevTools sockets through the single port like production.
const middleware = simMiddleware({ basePath: "/", execToken: EXEC_TOKEN, proxyHelpers: true });

// The dev server serves at the root (empty base), so endpoints look like
// `/logs`, `/grid/api`, etc. We point the advertised CLI binary at our local
// source so the sidebar's `serve-sim …` calls run from this checkout.
function devPreviewConfig(state: ServeSimState) {
  return previewConfigForState(state, "", SERVE_SIM_BIN, EXEC_TOKEN, undefined, true);
}

// ─── Client bundler with watch ───

let clientJs = "";
let clientError = "";
let tailwindCss = "";
const reloadClients = new Set<ServerResponse>();
let lastTailwindContentSignature = "";
let pendingClientBuild = false;
let pendingTailwindBuild = false;
let buildTimer: ReturnType<typeof setTimeout> | null = null;

function signalReload() {
  for (const res of reloadClients) {
    try {
      res.write("data: reload\n\n");
    } catch {
      reloadClients.delete(res);
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

async function buildHtml(selectedDevice?: string | null): Promise<string> {
  const state = selectServeSimState(await readServeSimStates(), selectedDevice);
  // Even with no helper attached the page polls the host (list/boot devices)
  // and streams `/api/events` over the control socket, so it always needs the
  // basePath + exec token.
  const config = state
    ? devPreviewConfig(state)
    : { basePath: "", execToken: EXEC_TOKEN };
  const configScript = `<script>window.__SIM_PREVIEW__=${JSON.stringify(config)}</script>`;

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

// ─── Dev-only routes ───

// Browser auto-reload channel: each open page holds one of these and reloads
// when a rebuild calls signalReload().
function handleDevReload(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":\n\n");
  reloadClients.add(res);
  req.on("close", () => reloadClients.delete(res));
}

// ─── Server ───

// Dev-only routes intercept first; everything else falls through to the
// production middleware — including `/grid/api/start`, which now boots + serves
// the device in-process (no spawned helper), so no dev override is needed.
async function devMiddleware(req: IncomingMessage, res: ServerResponse, next: () => Promise<void>): Promise<void> {
  const path = (req.url ?? "").split("?")[0];

  if (path === "/__dev/reload") return handleDevReload(req, res);
  if (path === "/" || path === "") {
    const device = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("device");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(await buildHtml(device));
    return;
  }

  middleware(req, res, next);
}
// Forward WebSocket upgrades (exec control + helper/DevTools proxy sockets) to
// the production middleware's handler.
devMiddleware.handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void =>
  middleware.handleUpgrade(req, socket, head);

await servePreview({ port: PORT, middleware: devMiddleware });

console.log(`\n  \x1b[36mserve-sim dev\x1b[0m  http://localhost:${PORT}\n`);
