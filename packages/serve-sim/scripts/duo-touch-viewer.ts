#!/usr/bin/env bun
/**
 * Web-viewer path of the Duo touch harness: clicks the projected screen of
 * the real 3D viewer page with agent-browser and checks each click against
 * the touch probe's log (scripts/duo-touch-probe).
 *
 * Click pixels come from the same projection frame (0x83) the viewer uses:
 * for a raw framebuffer target we find the leaf whose region contains it and
 * forward-map it through that leaf's perspective quad, then into the view
 * element's client rect. Accuracy is judged in raw (fixed/native portrait)
 * space, because that is what the viewer sends.
 *
 *   bun scripts/duo-touch-viewer.ts --udid <udid> --port <port> [--out <prefix>] [--poses closed,book,open]
 *       [--session duo-touch] [--rotate landscape_left]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Pose = "closed" | "book" | "open";
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const UDID = args.get("udid") ?? "";
const PORT = Number(args.get("port") ?? 3440);
const OUT = resolve(args.get("out") ?? "duo-touch-viewer");
const POSES = (args.get("poses") ?? "closed,book,open").split(",") as Pose[];
const SESSION = args.get("session") ?? "duo-touch";
const ROTATE = args.get("rotate") ?? "";
const MEDIA = args.get("media") ?? "";
const TOL = Number(args.get("tolerance") ?? 0.03);
const BUNDLE = "dev.servesim.touchprobe";
const CLI = join(resolve(import.meta.dir, ".."), "dist", "serve-sim.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ab(...a: string[]): string {
  const r = spawnSync("agent-browser", ["--session", SESSION, ...a], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`agent-browser ${a.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
const logPath = (() => {
  const r = spawnSync("xcrun", ["simctl", "get_app_container", UDID, BUNDLE, "data"], { encoding: "utf8" });
  return join(r.stdout.trim(), "Documents", "touches.jsonl");
})();
const offset = () => (existsSync(logPath) ? statSync(logPath).size : 0);
const readLog = (from: number) => readFileSync(logPath).subarray(from).toString("utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

async function socket(): Promise<{ ws: WebSocket; projection: Promise<any> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/helper/${UDID}/ws`);
  ws.binaryType = "arraybuffer";
  let resolveP!: (v: any) => void;
  const projection = new Promise((r) => (resolveP = r));
  ws.onmessage = ({ data }) => {
    const f = new Uint8Array(data as ArrayBuffer);
    if (f[0] === 0x83) resolveP(JSON.parse(new TextDecoder().decode(f.subarray(1))));
  };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")); });
  return { ws, projection };
}
async function latestProjection(): Promise<any> {
  const { ws, projection } = await socket();
  const p = await Promise.race([projection, sleep(3000).then(() => null)]);
  ws.close();
  return p;
}
async function setPose(pose: Pose): Promise<boolean> {
  const { ws } = await socket();
  const reply = new Promise<boolean>((res) => {
    const t = setTimeout(() => res(false), 12000);
    ws.addEventListener("message", ({ data }) => {
      const f = new Uint8Array(data as ArrayBuffer);
      if (f[0] !== 0x0e) return;
      clearTimeout(t);
      try { res(JSON.parse(new TextDecoder().decode(f.subarray(1))).ok === true); } catch { res(false); }
    });
  });
  const j = new TextEncoder().encode(JSON.stringify({ pose }));
  const m = new Uint8Array(1 + j.length); m[0] = 0x0e; m.set(j, 1); ws.send(m);
  const ok = await reply;
  ws.close();
  return ok;
}
async function diag(): Promise<any> {
  const d: any = await (await fetch(`http://127.0.0.1:${PORT}/api/diagnostics`)).json();
  return (d.sessions ?? []).find((x: any) => x.udid === UDID);
}

/** Forward-map a raw framebuffer point (0..1) through the projection (same math as projectDuoRect). */
function project(projection: any, x: number, y: number): [number, number] | null {
  for (const piece of projection.pieces) {
    if (piece.length !== 5) continue;
    const [p0, p1, p2, p3, region] = piece;
    if (x < region[0] || x > region[0] + region[2] || y < region[1] || y > region[1] + region[3]) continue;
    const dx1 = p1[0] - p2[0], dx2 = p3[0] - p2[0], dy1 = p1[1] - p2[1], dy2 = p3[1] - p2[1];
    const sx = p0[0] - p1[0] + p2[0] - p3[0], sy = p0[1] - p1[1] + p2[1] - p3[1];
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-10) continue;
    const g = (sx * dy2 - dx2 * sy) / det, h = (dx1 * sy - sx * dy1) / det;
    const u = (x - region[0]) / region[2], v = (y - region[1]) / region[3];
    const w = 1 + g * u + h * v;
    return [((p1[0] - p0[0] + g * p1[0]) * u + (p3[0] - p0[0] + h * p3[0]) * v + p0[0]) / w,
      ((p1[1] - p0[1] + g * p1[1]) * u + (p3[1] - p0[1] + h * p3[1]) * v + p0[1]) / w];
  }
  return null;
}

function viewRect(): { left: number; top: number; width: number; height: number } | null {
  const out = ab("eval", `(() => { const el = document.querySelector('[aria-label="Interactive 3D iPhone Duo"]'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({left:r.left,top:r.top,width:r.width,height:r.height}); })()`);
  try { const v = JSON.parse(out); return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
}

async function launchProbe() {
  spawnSync("xcrun", ["simctl", "launch", "--terminate-running-process", UDID, BUNDLE]);
  await sleep(2500);
}

// Raw targets: interior grid on both leaves (avoids the bottom home strip and the hinge line).
const TARGETS: [number, number][] = [
  [0.15, 0.15], [0.5, 0.15], [0.85, 0.15],
  [0.15, 0.35], [0.4, 0.35], [0.6, 0.35], [0.85, 0.35],
  [0.15, 0.62], [0.4, 0.62], [0.6, 0.62], [0.85, 0.62],
  [0.3, 0.8], [0.7, 0.8],
];

const shots: any[] = [];
const events: any[] = [];
const note = (e: any) => { events.push({ t: new Date().toISOString(), ...e }); console.log(JSON.stringify(e)); };

ab("open", `http://localhost:${PORT}`);
ab("set", "viewport", "1400", "1000");
await sleep(4000);

for (const pose of POSES) {
  const ok = await setPose(pose);
  await sleep(2500);
  if (ROTATE) { spawnSync("node", [CLI, "rotate", ROTATE, "-d", UDID]); await sleep(2000); }
  await launchProbe();
  await sleep(1500); // let the viewer render a settled frame
  const d = await diag();
  const projection = await latestProjection();
  const rect = viewRect();
  note({ event: "pose", pose, ok, rotate: ROTATE || "portrait", panel: projection?.panel, hinge: projection?.hingeDegrees, rect, server: d?.duo?.active_panel, screen: d?.screen });
  if (!projection || !rect) { note({ event: "skip", pose, reason: !projection ? "no projection" : "no view element" }); continue; }
  if (MEDIA) ab("screenshot", join(MEDIA, `viewer-${pose}${ROTATE ? "-" + ROTATE : ""}.png`));
  const expected = pose === "closed" ? "cover" : "inner";
  for (const [x, y] of TARGETS) {
    const p = project(projection, x, y);
    const shot: any = { pose, path: "viewer", orientation: ROTATE || "portrait", x, y, expectedDisplay: expected };
    if (!p) { shot.delivered = false; shot.note = "not on projected screen"; shots.push(shot); continue; }
    const px = rect.left + p[0] * rect.width, py = rect.top + p[1] * rect.height;
    shot.click = [Math.round(px), Math.round(py)];
    const from = offset();
    shot.sentWall = Date.now() / 1000;
    ab("mouse", "move", String(Math.round(px)), String(Math.round(py)));
    ab("mouse", "down");
    await sleep(40);
    ab("mouse", "up");
    await sleep(700);
    const began = readLog(from).find((l) => l.kind === "touch" && l.phase === "began");
    shot.delivered = !!began;
    if (began) {
      Object.assign(shot, { display: began.display, nx: began.nx, ny: began.ny, fx: began.fx, fy: began.fy, probeOrientation: began.orientation });
      shot.errRaw = Math.hypot(began.fx - x, began.fy - y);
      shot.accurate = shot.errRaw <= TOL && began.display === expected;
      shot.latencyMs = Math.round((began.wall - shot.sentWall) * 1000);
    }
    shots.push(shot);
  }
  const ss = shots.filter((s) => s.pose === pose && s.orientation === (ROTATE || "portrait"));
  note({ event: "viewer-grid", pose, sent: ss.length, delivered: ss.filter((s) => s.delivered).length, accurate: ss.filter((s) => s.accurate).length });
  if (ROTATE) { spawnSync("node", [CLI, "rotate", "portrait", "-d", UDID]); await sleep(1500); }
}

const keys = [...new Set(shots.map((s) => `${s.pose} | ${s.expectedDisplay} | viewer | ${s.orientation}`))];
const md = [
  `# Duo viewer-path touches (${new Date().toISOString()})`, ``,
  `| pose | expected display | path | orientation | sent | delivered | accurate | wrong display | med lat ms | max raw err |`,
  `|---|---|---|---|---|---|---|---|---|---|`,
  ...keys.map((k) => {
    const ss = shots.filter((s) => `${s.pose} | ${s.expectedDisplay} | viewer | ${s.orientation}` === k);
    const lat = ss.filter((s) => s.latencyMs != null).map((s) => s.latencyMs).sort((a, b) => a - b);
    const err = ss.filter((s) => s.errRaw != null).map((s) => s.errRaw);
    return `| ${k} | ${ss.length} | ${ss.filter((s) => s.delivered).length} | ${ss.filter((s) => s.accurate).length} | ${ss.filter((s) => s.delivered && s.display !== s.expectedDisplay).length} | ${lat[Math.floor(lat.length / 2)] ?? "-"} | ${err.length ? Math.max(...err).toFixed(4) : "-"} |`;
  }),
  ``, `## Misses`, ``,
  ...shots.filter((s) => !s.accurate).map((s) => `- ${s.pose}/${s.orientation} raw(${s.x},${s.y}) click=${s.click ?? "-"} delivered=${s.delivered}${s.delivered ? ` on ${s.display} at raw(${s.fx?.toFixed(3)},${s.fy?.toFixed(3)})` : ""}${s.note ? ` (${s.note})` : ""}`),
].join("\n");
writeFileSync(`${OUT}.json`, JSON.stringify({ udid: UDID, port: PORT, shots, events }, null, 2));
writeFileSync(`${OUT}.md`, md + "\n");
console.log(md);
