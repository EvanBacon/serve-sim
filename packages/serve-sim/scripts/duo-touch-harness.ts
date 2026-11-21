#!/usr/bin/env bun
/**
 * iPhone Duo touch-reliability harness.
 *
 * Measures ground truth with the touch probe app (scripts/duo-touch-probe):
 * every tap/drag is checked against the probe's own touch log for delivery,
 * accuracy, display, and latency. Runs against an already-running local
 * serve-sim server for one simulator; it never boots, kills, or repairs.
 *
 *   bun scripts/duo-touch-harness.ts --udid <udid> --port <port> [--out <prefix>]
 *       [--suites grid,drag,rapid,after-pose,toggle,rotate,long] [--poses closed,book,open]
 *       [--paths cli,ws]
 *
 * Paths:
 *   cli — spawns `node dist/serve-sim.js tap|gesture … -d <udid>` exactly as a user would.
 *   ws  — the same 0x03 frames over one WebSocket (needed for 80 ms bursts and drags).
 * The web-viewer path is measured separately (see duo-touch-viewer.ts).
 *
 * Writes <out>.json and <out>.md.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Pose = "closed" | "book" | "open";
type Path = "cli" | "ws";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const UDID = args.get("udid") ?? "";
const PORT = Number(args.get("port") ?? 3440);
const OUT = resolve(args.get("out") ?? "duo-touch-results");
const SUITES = new Set((args.get("suites") ?? "grid,drag,rapid,after-pose,toggle,rotate,long").split(","));
const POSES = (args.get("poses") ?? "closed,book,open").split(",") as Pose[];
const PATHS = (args.get("paths") ?? "cli,ws").split(",") as Path[];
const TOL = Number(args.get("tolerance") ?? 0.03);
const BUNDLE = "dev.servesim.touchprobe";
const PKG = resolve(import.meta.dir, "..");
const CLI = join(PKG, "dist", "serve-sim.js");
if (!UDID) throw new Error("--udid is required");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = `http://127.0.0.1:${PORT}/helper/${UDID}`;

// ── probe log ──────────────────────────────────────────────────────────────
type ProbeLine = Record<string, any>;
let logPath = "";
function probeLogPath(): string {
  const r = spawnSync("xcrun", ["simctl", "get_app_container", UDID, BUNDLE, "data"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`probe not installed: ${r.stderr}`);
  return join(r.stdout.trim(), "Documents", "touches.jsonl");
}
function logOffset(): number { return existsSync(logPath) ? statSync(logPath).size : 0; }
function readLog(from: number): ProbeLine[] {
  if (!existsSync(logPath)) return [];
  const buf = readFileSync(logPath);
  return buf.subarray(from).toString("utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

// ── server helpers ─────────────────────────────────────────────────────────
async function config(): Promise<any> { return (await fetch(`${BASE}/config`)).json(); }
async function duoDiag(): Promise<any> {
  const d: any = await (await fetch(`http://127.0.0.1:${PORT}/api/diagnostics`)).json();
  const s = (d.sessions ?? []).find((x: any) => x.udid === UDID);
  return { screen: s?.screen, duo: s?.duo, hid: s?.hid, captured: s?.native?.capture?.captured };
}

class Hid {
  ws!: WebSocket;
  private waiters: ((f: Uint8Array) => boolean)[] = [];
  private ack = 1;
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/helper/${UDID}/ws`);
    this.ws.binaryType = "arraybuffer";
    await new Promise<void>((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error("ws failed")); });
    this.ws.onmessage = ({ data }) => {
      const f = new Uint8Array(data as ArrayBuffer);
      this.waiters = this.waiters.filter((w) => !w(f));
    };
  }
  send(tag: number, payload: object) {
    const j = new TextEncoder().encode(JSON.stringify(payload));
    const m = new Uint8Array(1 + j.length); m[0] = tag; m.set(j, 1); this.ws.send(m);
  }
  wait(tag: number, pred: (body: any) => boolean, timeoutMs: number): Promise<any> {
    return new Promise((res) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== fn); res(null); }, timeoutMs);
      const fn = (f: Uint8Array) => {
        if (f[0] !== tag) return false;
        let body: any; try { body = JSON.parse(new TextDecoder().decode(f.subarray(1))); } catch { return false; }
        if (!pred(body)) return false;
        clearTimeout(t); res(body); return true;
      };
      this.waiters.push(fn);
    });
  }
  /** 0x03 with an ack id; resolves {ok,error} (or null on timeout). */
  async touch(t: { type: string; x: number; y: number; edge?: number }, waitAck = true): Promise<any> {
    const ack = this.ack++;
    const p = this.wait(0x84, (b) => b.ack === ack, 3000);
    this.send(0x03, { ...t, ack });
    return waitAck ? p : (p.catch(() => null), { ok: undefined });
  }
  async pose(pose: Pose): Promise<boolean> {
    const p = this.wait(0x0e, (b) => "ok" in b, 12000);
    this.send(0x0e, { pose });
    return (await p)?.ok === true;
  }
  close() { try { this.ws.close(); } catch {} }
}

function cli(args: string[]): { rc: number; ms: number; err: string } {
  const t0 = performance.now();
  const r = spawnSync("node", [CLI, ...args, "-d", UDID], { encoding: "utf8", timeout: 20000 });
  return { rc: r.status ?? -1, ms: Math.round(performance.now() - t0), err: (r.stderr || "").trim().split("\n")[0] ?? "" };
}

// ── probe control ──────────────────────────────────────────────────────────
async function launchProbe(): Promise<ProbeLine | null> {
  const from = logOffset();
  spawnSync("xcrun", ["simctl", "launch", "--terminate-running-process", UDID, BUNDLE], { encoding: "utf8" });
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const active = readLog(from).filter((l) => l.kind === "scene" && l.event === "active").pop();
    if (active) { await sleep(400); return lastScene(from) ?? active; }
  }
  return null;
}
function lastScene(from: number): ProbeLine | null {
  return readLog(from).filter((l) => l.kind === "scene").pop() ?? null;
}

const expectedDisplay = (pose: Pose) => (pose === "closed" ? "cover" : "inner");

// ── matching ───────────────────────────────────────────────────────────────
type Shot = {
  suite: string; pose: Pose; path: string; orientation: string; label?: string;
  x: number; y: number; sentWall: number; ok: boolean | null; error?: string; cmdMs?: number;
  delivered?: boolean; display?: string; probeOrientation?: string; nx?: number; ny?: number; fx?: number; fy?: number;
  errDisplay?: number; errRaw?: number; accurate?: boolean; latencyMs?: number; expectedDisplay?: string;
  serverPanel?: string; serverSize?: string; touchCount?: number;
};

/** Pair each shot with the first unclaimed `began` after it was sent. */
function matchShots(shots: Shot[], lines: ProbeLine[], expected: string) {
  const began = lines.filter((l) => l.kind === "touch" && l.phase === "began");
  const used = new Set<number>();
  shots.forEach((s, k) => {
    const until = shots[k + 1]?.sentWall ?? s.sentWall + 2.5;
    const cand = began.find((l, i) => !used.has(i) && l.wall >= s.sentWall - 0.02 && l.wall < until);
    s.expectedDisplay = expected;
    if (!cand) { s.delivered = false; return; }
    used.add(began.indexOf(cand));
    s.delivered = true;
    s.display = cand.display; s.probeOrientation = cand.orientation;
    s.nx = cand.nx; s.ny = cand.ny; s.fx = cand.fx; s.fy = cand.fy; s.touchCount = cand.touchCount;
    s.errDisplay = Math.hypot(cand.nx - s.x, cand.ny - s.y);
    s.errRaw = Math.hypot(cand.fx - s.x, cand.fy - s.y);
    // Contract: CLI coordinates are normalized display (window) space.
    s.accurate = s.errDisplay <= TOL && cand.display === expected;
    s.latencyMs = Math.round((cand.wall - s.sentWall) * 1000);
  });
}

// ── suites ─────────────────────────────────────────────────────────────────
const GRID_X = [0.1, 0.5, 0.9];
const GRID_Y = [0.08, 0.3, 0.5, 0.7, 0.88];
const results: Shot[] = [];
const drags: any[] = [];
const events: any[] = [];
const note = (e: any) => { events.push({ t: new Date().toISOString(), ...e }); console.log(JSON.stringify(e)); };

async function tapVia(path: Path, hid: Hid, x: number, y: number): Promise<{ ok: boolean | null; error?: string; cmdMs?: number; sentWall: number }> {
  const sentWall = Date.now() / 1000;
  if (path === "cli") {
    const r = cli(["tap", String(x), String(y)]);
    return { ok: r.rc === 0, error: r.rc ? r.err : undefined, cmdMs: r.ms, sentWall };
  }
  const a = await hid.touch({ type: "begin", x, y });
  await sleep(40);
  const b = await hid.touch({ type: "end", x, y });
  const ok = a?.ok === true && b?.ok === true;
  return { ok, error: ok ? undefined : (a?.error ?? b?.error ?? (a && b ? "nack" : "ack timeout")), sentWall };
}

async function settlePose(hid: Hid, pose: Pose): Promise<any> {
  const t0 = Date.now();
  const ok = await hid.pose(pose);
  const want = expectedDisplay(pose);
  let diag: any = null;
  for (let i = 0; i < 40; i++) {
    diag = await duoDiag();
    if (diag.duo?.active_panel === want && diag.captured && ((want === "cover") === (diag.captured.width === 1398))) break;
    await sleep(250);
  }
  note({ event: "pose", pose, ok, settleMs: Date.now() - t0, active_panel: diag?.duo?.active_panel, primary_panel: diag?.duo?.primary_panel, hinge: diag?.duo?.hinge_degrees, captured: diag?.captured, screen: diag?.screen });
  return diag;
}

async function grid(hid: Hid, pose: Pose, path: Path, suite: string, orientation: string, points: [number, number][]) {
  const diag = await duoDiag();
  const from = logOffset();
  const shots: Shot[] = [];
  for (const [x, y] of points) {
    const r = await tapVia(path, hid, x, y);
    shots.push({ suite, pose, path, orientation, x, y, ...r, serverPanel: diag.duo?.active_panel, serverSize: diag.screen ? `${diag.screen.width}x${diag.screen.height}` : undefined });
    await sleep(path === "cli" ? 150 : 250);
  }
  await sleep(800);
  matchShots(shots, readLog(from), expectedDisplay(pose));
  results.push(...shots);
  const d = shots.filter((s) => s.delivered).length, a = shots.filter((s) => s.accurate).length;
  note({ event: suite, pose, path, orientation, sent: shots.length, delivered: d, accurate: a });
}

async function drag(hid: Hid, pose: Pose, path: Path, orientation: string, from: [number, number], to: [number, number]) {
  const off = logOffset();
  const steps = 12;
  const pts = Array.from({ length: steps + 1 }, (_, i) => [from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps] as [number, number]);
  const sent = Date.now() / 1000;
  let acks: any[] = [];
  if (path === "cli") {
    acks.push(cli(["gesture", JSON.stringify({ type: "begin", x: pts[0]![0], y: pts[0]![1] })]).rc === 0);
    for (const p of pts.slice(1)) acks.push(cli(["gesture", JSON.stringify({ type: "move", x: p[0], y: p[1] })]).rc === 0);
    acks.push(cli(["gesture", JSON.stringify({ type: "end", x: to[0], y: to[1] })]).rc === 0);
  } else {
    acks.push((await hid.touch({ type: "begin", x: pts[0]![0], y: pts[0]![1] }))?.ok === true);
    for (const p of pts.slice(1)) { await sleep(16); acks.push((await hid.touch({ type: "move", x: p[0], y: p[1] }))?.ok === true); }
    acks.push((await hid.touch({ type: "end", x: to[0], y: to[1] }))?.ok === true);
  }
  await sleep(800);
  const lines = readLog(off).filter((l) => l.kind === "touch" && l.wall >= sent - 0.02);
  const began = lines.find((l) => l.phase === "began"), ended = lines.filter((l) => l.phase === "ended" || l.phase === "cancelled").pop();
  const moved = lines.filter((l) => l.phase === "moved").length;
  const r = {
    pose, path, orientation, from, to, acked: acks.filter(Boolean).length, sent: acks.length,
    began: began ? [began.nx, began.ny] : null, ended: ended ? [ended.nx, ended.ny, ended.phase] : null, moved,
    display: began?.display,
    ok: !!began && !!ended && ended.phase === "ended" && Math.hypot(began.nx - from[0], began.ny - from[1]) <= TOL && Math.hypot(ended.nx - to[0], ended.ny - to[1]) <= TOL && moved >= steps / 2 && began.display === expectedDisplay(pose),
  };
  drags.push(r);
  note({ event: "drag", ...r });
}

async function rapid(hid: Hid, pose: Pose, orientation: string) {
  const from = logOffset();
  const shots: Shot[] = [];
  for (let i = 0; i < 10; i++) {
    const x = 0.2 + 0.06 * i, y = 0.5;
    const sentWall = Date.now() / 1000;
    const a = hid.touch({ type: "begin", x, y });
    await sleep(40);
    const b = hid.touch({ type: "end", x, y });
    const [ra, rb] = await Promise.all([a, b]);
    shots.push({ suite: "rapid", pose, path: "ws", orientation, x, y, sentWall, ok: ra?.ok === true && rb?.ok === true, error: ra?.error ?? rb?.error });
    await sleep(40);
  }
  await sleep(1000);
  matchShots(shots, readLog(from), expectedDisplay(pose));
  results.push(...shots);
  note({ event: "rapid", pose, sent: 10, delivered: shots.filter((s) => s.delivered).length, accurate: shots.filter((s) => s.accurate).length });
}

/** Tap right after a pose ack, at several delays, using a fresh pose each time. */
async function afterPose(hid: Hid) {
  const seq: Pose[] = ["open", "closed", "book", "closed", "open", "book", "closed"];
  const delays = [0, 100, 300, 1000, 2500];
  let i = 0;
  for (const delay of delays) {
    for (const pose of [seq[i % seq.length]!, seq[(i + 1) % seq.length]!]) {
      i++;
      const ok = await hid.pose(pose);
      await sleep(delay);
      const diag = await duoDiag();
      const from = logOffset();
      const r = await tapVia("ws", hid, 0.5, 0.45);
      const shot: Shot = { suite: "after-pose", label: `delay=${delay}`, pose, path: "ws", orientation: "portrait", x: 0.5, y: 0.45, ...r, serverPanel: diag.duo?.active_panel, serverSize: diag.screen ? `${diag.screen.width}x${diag.screen.height}` : undefined };
      await sleep(900);
      matchShots([shot], readLog(from), expectedDisplay(pose));
      results.push(shot);
      note({ event: "after-pose", pose, poseOk: ok, delay, delivered: shot.delivered, display: shot.display, serverPanel: shot.serverPanel, serverSize: shot.serverSize, ack: r.ok, err: shot.errDisplay });
      // Let the app move/settle before the next pose so the probe stays frontmost.
      await sleep(1500);
    }
  }
}

/** Taps fired while the fold sweep is still running (no wait for the pose ack), as a viewer user would. */
async function duringPose(hid: Hid) {
  const pairs: [Pose, Pose][] = [["closed", "open"], ["open", "closed"], ["closed", "book"], ["book", "closed"]];
  const delays = [0, 150, 400, 700, 1000, 1500];
  for (const [fromPose, toPose] of pairs) {
    for (const delay of delays) {
      await settlePose(hid, fromPose);
      await launchProbe();
      const from = logOffset();
      const poseDone = hid.pose(toPose);
      await sleep(delay);
      const diag = await duoDiag();
      const r = await tapVia("ws", hid, 0.5, 0.5);
      const shot: Shot = { suite: "during-pose", label: `${fromPose}->${toPose} +${delay}ms`, pose: toPose, path: "ws", orientation: "portrait", x: 0.5, y: 0.5, ...r, serverPanel: diag.duo?.active_panel, serverSize: diag.screen ? `${diag.screen.width}x${diag.screen.height}` : undefined };
      const ok = await poseDone;
      await sleep(1200);
      matchShots([shot], readLog(from), expectedDisplay(toPose));
      // Center taps are rotation-independent, so a miss here is delivery or display, not orientation.
      results.push(shot);
      note({ event: "during-pose", from: fromPose, to: toPose, delay, poseOk: ok, ack: r.ok, delivered: shot.delivered, display: shot.display, serverPanel: shot.serverPanel, serverSize: shot.serverSize, err: shot.errDisplay });
    }
  }
}

// ── main ───────────────────────────────────────────────────────────────────
const gridPoints: [number, number][] = GRID_Y.flatMap((y) => GRID_X.map((x) => [x, y] as [number, number]));
const smallGrid: [number, number][] = [[0.2, 0.25], [0.5, 0.25], [0.8, 0.25], [0.2, 0.5], [0.5, 0.5], [0.8, 0.5], [0.2, 0.75], [0.5, 0.75], [0.8, 0.75]];

logPath = probeLogPath();
const hid = new Hid();
await hid.open();
const started = new Date().toISOString();
note({ event: "start", udid: UDID, port: PORT, config: await config(), diag: await duoDiag() });

for (const pose of POSES) {
  await settlePose(hid, pose);
  const scene = await launchProbe();
  note({ event: "probe", pose, display: scene?.display, orientation: scene?.orientation, window: scene?.window });
  if (SUITES.has("grid")) for (const path of PATHS) await grid(hid, pose, path, "grid", "portrait", gridPoints);
  if (SUITES.has("drag")) for (const path of PATHS) {
    await drag(hid, pose, path, "portrait", [0.2, 0.55], [0.8, 0.55]);
    await drag(hid, pose, path, "portrait", [0.5, 0.25], [0.5, 0.75]);
  }
  if (SUITES.has("rapid")) await rapid(hid, pose, "portrait");
  if (SUITES.has("rotate")) {
    const r = cli(["rotate", "landscape_left"]);
    await sleep(1500);
    const sc = lastScene(0);
    note({ event: "rotate", pose, rc: r.rc, err: r.err, probeOrientation: sc?.orientation, window: sc?.window, config: await config() });
    for (const path of PATHS) await grid(hid, pose, path, "rotate", "landscape_left", smallGrid);
    await drag(hid, pose, "ws", "landscape_left", [0.2, 0.5], [0.8, 0.5]);
    cli(["rotate", "portrait"]);
    await sleep(1500);
  }
}

if (SUITES.has("after-pose")) {
  await launchProbe();
  await afterPose(hid);
}

if (SUITES.has("during-pose")) await duringPose(hid);

if (SUITES.has("toggle")) {
  for (const p of ["open", "closed", "book", "closed", "open", "book", "open", "closed"] as Pose[]) { await hid.pose(p); await sleep(300); }
  for (const pose of ["closed", "open"] as Pose[]) {
    await settlePose(hid, pose);
    await launchProbe();
    await grid(hid, pose, "ws", "toggle", "portrait", smallGrid);
  }
}

if (SUITES.has("long")) {
  // ~3 minutes of mixed taps on the current pose, relaunching nothing.
  const pose: Pose = "open";
  await settlePose(hid, pose);
  await launchProbe();
  const end = Date.now() + Number(args.get("long-ms") ?? 180000);
  let round = 0;
  while (Date.now() < end) {
    await grid(hid, pose, round % 4 === 0 ? "cli" : "ws", "long", "portrait", smallGrid);
    round++;
    await sleep(2000);
  }
}

hid.close();

// ── report ─────────────────────────────────────────────────────────────────
type Row = { key: string; sent: number; acked: number; delivered: number; accurate: number; wrongDisplay: number; medLat: number | null; p95Lat: number | null; maxErr: number | null };
function summarize(keyOf: (s: Shot) => string): Row[] {
  const groups = new Map<string, Shot[]>();
  for (const s of results) { const k = keyOf(s); groups.set(k, [...(groups.get(k) ?? []), s]); }
  return [...groups].map(([key, ss]) => {
    const lats = ss.filter((s) => s.latencyMs != null).map((s) => s.latencyMs!).sort((a, b) => a - b);
    const errs = ss.filter((s) => s.errDisplay != null).map((s) => s.errDisplay!);
    return {
      key, sent: ss.length, acked: ss.filter((s) => s.ok).length, delivered: ss.filter((s) => s.delivered).length,
      accurate: ss.filter((s) => s.accurate).length, wrongDisplay: ss.filter((s) => s.delivered && s.display !== s.expectedDisplay).length,
      medLat: lats.length ? lats[Math.floor(lats.length / 2)]! : null, p95Lat: lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))]! : null,
      maxErr: errs.length ? Number(Math.max(...errs).toFixed(4)) : null,
    };
  });
}
const rows = summarize((s) => `${s.suite} | ${s.pose} | ${s.expectedDisplay} | ${s.path} | ${s.orientation}${s.label ? ` | ${s.label}` : ""}`);
const md = [
  `# Duo touch harness — ${started}`,
  ``,
  `udid ${UDID}, port ${PORT}, tolerance ${TOL * 100}% of window (display space). Latency = probe began wall time − send time (cli includes node startup).`,
  ``,
  `| suite | pose | expected display | path | orientation | sent | acked | delivered | accurate | wrong display | med lat ms | p95 lat ms | max err |`,
  `|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.key.split(" | ").concat(r.key.split(" | ").length < 6 ? [] : []).slice(0, 5).join(" | ")}${r.key.split(" | ")[5] ? ` (${r.key.split(" | ")[5]})` : ""} | ${r.sent} | ${r.acked} | ${r.delivered} | ${r.accurate} | ${r.wrongDisplay} | ${r.medLat ?? "-"} | ${r.p95Lat ?? "-"} | ${r.maxErr ?? "-"} |`),
  ``,
  `## Drags`,
  ``,
  `| pose | path | orientation | from → to | acked/sent | began | ended | moved | display | ok |`,
  `|---|---|---|---|---|---|---|---|---|---|`,
  ...drags.map((d) => `| ${d.pose} | ${d.path} | ${d.orientation} | ${d.from} → ${d.to} | ${d.acked}/${d.sent} | ${d.began?.map((n: number) => n.toFixed(3)) ?? "-"} | ${d.ended ? `${(+d.ended[0]).toFixed(3)},${(+d.ended[1]).toFixed(3)} ${d.ended[2]}` : "-"} | ${d.moved} | ${d.display ?? "-"} | ${d.ok ? "✅" : "❌"} |`),
  ``,
  `## Misses`,
  ``,
  ...results.filter((s) => !s.accurate).map((s) => `- ${s.suite}/${s.pose}/${s.path}/${s.orientation}${s.label ? `/${s.label}` : ""} (${s.x},${s.y}) ack=${s.ok}${s.error ? ` err="${s.error}"` : ""} delivered=${s.delivered}${s.delivered ? ` on ${s.display} ${s.probeOrientation} at display(${s.nx?.toFixed(3)},${s.ny?.toFixed(3)}) raw(${s.fx?.toFixed(3)},${s.fy?.toFixed(3)})` : ""} server=${s.serverPanel ?? "?"} ${s.serverSize ?? ""}`),
].join("\n");
writeFileSync(`${OUT}.json`, JSON.stringify({ started, udid: UDID, port: PORT, tolerance: TOL, rows, drags, shots: results, events }, null, 2));
writeFileSync(`${OUT}.md`, md + "\n");
console.log(md);
