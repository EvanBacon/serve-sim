#!/usr/bin/env bun
/**
 * Unified serve-sim build.
 *
 * Produces, all minified and with no runtime deps on workspace packages:
 *   dist/serve-sim.js      ESM bin (node target) referenced by package.json#bin
 *   dist/serve-sim         Compiled single-file executable (bun --compile)
 *   dist/middleware.js    Public subpath export "serve-sim/middleware" (ESM)
 *   dist/middleware.cjs   Thin CJS wrapper for the same
 *
 * The bin and middleware bundles target `node` so users without `bun` on
 * their PATH can still run `npx serve-sim` / mount the Connect middleware.
 * Runtime server and timing behavior is implemented with Node stdlib APIs.
 *
 * The preview HTML (bundled client.tsx + Preact + serve-sim-client, base64
 * encoded) is injected into every artifact that could need to serve the UI
 * via the __PREVIEW_HTML_B64__ build-time define.
 */
import { resolve } from "path";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import tailwindPlugin from "bun-plugin-tailwind";

const root = import.meta.dir;
const distDir = resolve(root, "dist");
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

function kb(n: number): string {
  return `${(n / 1024).toFixed(1)} KB`;
}

// ─── 1. Bundle the browser client (React aliased to Preact) ───────────────

const preactPlugin = {
  name: "preact-alias",
  setup(build: any) {
    const preactCompat = resolve(root, "node_modules/preact/compat/dist/compat.module.js");
    const preactCompatClient = resolve(root, "node_modules/preact/compat/client.mjs");
    const preactJsxRuntime = resolve(root, "node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js");
    build.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: preactCompatClient }));
    build.onResolve({ filter: /^react(-dom)?$/ }, () => ({ path: preactCompat }));
    build.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, () => ({ path: preactJsxRuntime }));
  },
};

async function buildTailwindCss(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(root, "src/client/global.css")],
    minify: true,
    plugins: [tailwindPlugin],
  });
  if (!result.success) {
    console.error("Tailwind build failed:");
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const css = await result.outputs[0]!.text();
  console.log(`tailwind css      ${kb(css.length)}`);
  return css;
}

async function bundleBrowserClient(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(root, entry)],
    minify: true,
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [preactPlugin],
  });
  if (!result.success) {
    console.error(`Build failed for ${entry}:`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  return (await result.outputs[0]!.text()).replace(/<\/script>/gi, "<\\/script>");
}

const tailwindCss = await buildTailwindCss();
const clientJs = await bundleBrowserClient("src/client/client.tsx");
console.log(`client bundle     ${kb(clientJs.length)}`);

// ─── 2. Inline client into preview HTML, base64-encode for the define ────

// Committed ICO copy of Simulator.app's AppIcon, inlined as a data URI so the
// preview tab shows the same icon as the native app.
const faviconBytes = readFileSync(resolve(root, "src/client/simulator-icon.ico"));
const faviconTag = `<link rel="icon" type="image/x-icon" href="data:image/x-icon;base64,${faviconBytes.toString("base64")}">`;
console.log(`favicon           ${kb(faviconBytes.length)}`);

const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulator Preview</title>
${faviconTag}
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}</style>
<style>${tailwindCss}</style>
</head><body>
<div id="root"></div>
<!--__SIM_PREVIEW_CONFIG__-->
<script type="module">${clientJs}</script>
</body></html>`;

const htmlB64 = Buffer.from(html).toString("base64");
console.log(`preview html      ${kb(html.length)}  (base64 ${kb(htmlB64.length)})`);

const PREVIEW_DEFINE = {
  __PREVIEW_HTML_B64__: JSON.stringify(htmlB64),
};

// ─── 3. Middleware ESM (serve-sim/middleware) ─────────────────────────────

const mwResult = await Bun.build({
  entrypoints: [resolve(root, "src/middleware.ts")],
  target: "node",
  format: "esm",
  minify: true,
  outdir: distDir,
  external: ["fs", "path", "os", "child_process", "url", "net", "tls", "crypto", "stream", "events", "http", "https", "zlib", "buffer", "module"],
  define: PREVIEW_DEFINE,
});
if (!mwResult.success) {
  console.error("Middleware build failed:");
  for (const log of mwResult.logs) console.error(log);
  process.exit(1);
}
const mwSize = (await mwResult.outputs[0]!.text()).length;
console.log(`dist/middleware.js ${kb(mwSize)}`);

writeFileSync(
  resolve(distDir, "middleware.cjs"),
  `"use strict";\nmodule.exports = require("./middleware.js");\n`,
);
console.log("dist/middleware.cjs (wrapper)");

// ─── 4. Bin JS bundle ────────────────────────────────────────────────────

const binJsResult = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  target: "node",
  format: "esm",
  minify: true,
  outdir: distDir,
  naming: "serve-sim.js",
  external: ["fs", "path", "os", "child_process", "url", "net", "tls", "crypto", "stream", "events", "http", "https", "zlib", "buffer", "module"],
  define: PREVIEW_DEFINE,
});
if (!binJsResult.success) {
  console.error("Bin JS build failed:");
  for (const log of binJsResult.logs) console.error(log);
  process.exit(1);
}

const binJsSize = (await binJsResult.outputs[0]!.text()).length;
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
    "--outfile", resolve(distDir, "serve-sim"),
    "--define", `__PREVIEW_HTML_B64__=${JSON.stringify(htmlB64)}`,
  ],
  { stdio: "inherit" },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);
console.log("dist/serve-sim      (compiled binary)");

console.log("Done.");
