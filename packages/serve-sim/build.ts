#!/usr/bin/env bun
/**
 * Unified serve-sim build.
 *
 * Produces, all minified and with no runtime deps on workspace packages:
 *   dist/serve-sim.js      ESM bin (bun target) referenced by package.json#bin
 *   dist/serve-sim         Compiled single-file executable (bun --compile)
 *   dist/middleware.js    Public subpath export "serve-sim/middleware" (ESM)
 *   dist/middleware.cjs   Thin CJS wrapper for the same
 *
 * The preview HTML (bundled client.tsx + Preact + serve-sim-client, base64
 * encoded) is injected into every artifact that could need to serve the UI
 * via the __PREVIEW_HTML_B64__ build-time define.
 */
import { resolve, dirname } from "path";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";

const root = import.meta.dir;
const distDir = resolve(root, "dist");

/** Resolve a hoisted workspace dependency (preact may live in repo root `node_modules`). */
function resolvePackageDir(packageName: string, startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = resolve(dir, "node_modules", packageName);
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find "${packageName}" under node_modules (walked up from ${startDir}). Run install from the repo root.`,
      );
    }
    dir = parent;
  }
}
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

function kb(n: number): string {
  return `${(n / 1024).toFixed(1)} KB`;
}

// ─── 1. Bundle the browser client (React aliased to Preact) ───────────────

const preactRoot = resolvePackageDir("preact", root);
const preactCompat = resolve(preactRoot, "compat/dist/compat.module.js");
const preactCompatClient = resolve(preactRoot, "compat/client.mjs");
const preactJsxRuntime = resolve(
  preactRoot,
  "jsx-runtime/dist/jsxRuntime.module.js",
);

const clientResult = await Bun.build({
  entrypoints: [resolve(root, "src/client/client.tsx")],
  minify: true,
  target: "browser",
  format: "esm",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "preact-alias",
      setup(build) {
        build.onResolve({ filter: /^react-dom\/client$/ }, () => ({
          path: preactCompatClient,
        }));
        build.onResolve({ filter: /^react(-dom)?$/ }, () => ({
          path: preactCompat,
        }));
        build.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, () => ({
          path: preactJsxRuntime,
        }));
      },
    },
  ],
});

if (!clientResult.success) {
  console.error("Client build failed:");
  for (const log of clientResult.logs) console.error(log);
  process.exit(1);
}

const clientJs = (await clientResult.outputs[0].text()).replace(
  /<\/script>/gi,
  "<\\/script>",
);
console.log(`client bundle     ${kb(clientJs.length)}`);

// ─── 2. Inline client into preview HTML, base64-encode for the define ────

// Committed ICO copy of Simulator.app's AppIcon, inlined as a data URI so the
// preview tab shows the same icon as the native app.
const faviconBytes = readFileSync(
  resolve(root, "src/client/simulator-icon.ico"),
);
const faviconTag = `<link rel="icon" type="image/x-icon" href="data:image/x-icon;base64,${faviconBytes.toString("base64")}">`;
console.log(`favicon           ${kb(faviconBytes.length)}`);

const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulator Preview</title>
${faviconTag}
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}</style>
</head><body>
<div id="root"></div>
<!--__SIM_PREVIEW_CONFIG__-->
<script type="module">${clientJs}</script>
</body></html>`;

const htmlB64 = Buffer.from(html).toString("base64");
console.log(
  `preview html      ${kb(html.length)}  (base64 ${kb(htmlB64.length)})`,
);

const PREVIEW_DEFINE = { __PREVIEW_HTML_B64__: JSON.stringify(htmlB64) };

// ─── 3. Middleware ESM (serve-sim/middleware) ─────────────────────────────

const mwResult = await Bun.build({
  entrypoints: [resolve(root, "src/middleware.ts")],
  target: "bun",
  format: "esm",
  minify: true,
  outdir: distDir,
  external: [
    "fs",
    "path",
    "os",
    "child_process",
    "url",
    "http",
    "http-proxy",
    "net",
    "stream",
  ],
  define: PREVIEW_DEFINE,
});
if (!mwResult.success) {
  console.error("Middleware build failed:");
  for (const log of mwResult.logs) console.error(log);
  process.exit(1);
}
const mwSize = (await mwResult.outputs[0].text()).length;
console.log(`dist/middleware.js ${kb(mwSize)}`);

writeFileSync(
  resolve(distDir, "middleware.cjs"),
  `"use strict";\nmodule.exports = require("./middleware.js");\n`,
);
console.log("dist/middleware.cjs (wrapper)");

// ─── 4. Bin JS bundle ────────────────────────────────────────────────────

const binJsResult = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  target: "bun",
  format: "esm",
  minify: true,
  outdir: distDir,
  naming: "serve-sim.js",
  external: [
    "fs",
    "path",
    "os",
    "child_process",
    "url",
    "net",
    "tls",
    "crypto",
    "stream",
    "events",
    "http",
    "https",
    "http-proxy",
    "zlib",
    "buffer",
  ],
  define: PREVIEW_DEFINE,
});
if (!binJsResult.success) {
  console.error("Bin JS build failed:");
  for (const log of binJsResult.logs) console.error(log);
  process.exit(1);
}
const binJsSize = (await binJsResult.outputs[0].text()).length;
console.log(`dist/serve-sim.js   ${kb(binJsSize)}`);

// ─── 5. Compiled single-file executable ──────────────────────────────────
// Bun.build doesn't expose --compile yet, so shell out. The define arg carries
// the base64 HTML (~100 KB) which is well under the macOS ARG_MAX.

const compile = spawnSync(
  "bun",
  [
    "build",
    "--compile",
    "--minify",
    resolve(root, "src/index.ts"),
    "--outfile",
    resolve(distDir, "serve-sim"),
    "--define",
    `__PREVIEW_HTML_B64__=${JSON.stringify(htmlB64)}`,
  ],
  { stdio: "inherit" },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);
console.log("dist/serve-sim      (compiled binary)");

console.log("Done.");
