#!/usr/bin/env bun
/**
 * End-to-end simulator streaming benchmark.
 *
 * Opens a stimulus page in the simulator's Safari (served from this process),
 * then measures, against a running stream server:
 *
 *   - latency:  stimulus → first changed frame received by the stream client.
 *               The stimulus is either a WebSocket "flip" pushed to the page
 *               (`--stimulus page`, isolates the video pipeline) or a tap sent
 *               through serve-sim's HID WebSocket (`--stimulus tap`, adds the
 *               input-injection path). A native framebuffer probe
 *               (native-probe.swift) timestamps the same change on the
 *               simulator's IOSurface, so `client − native` is the pure
 *               capture → encode → transport overhead of the tool under test.
 *   - fps / bytes per frame while the page animates full-screen noise at rAF.
 *   - server CPU (process tree of whatever listens on the target port).
 *
 * Usage (see README.md; run-target.sh / bench-suite.sh wrap this):
 *   bun scripts/bench/bench-stream.ts --udid <udid> --label main \
 *     --kind serve-sim --base http://127.0.0.1:4101/helper/<udid> --codec avcc
 *   bun scripts/bench/bench-stream.ts --udid <udid> --kind baguette \
 *     --base 'ws://127.0.0.1:4150/simulators/<udid>/stream?format=avcc'
 *
 * Prints a summary and writes the full JSON (incl. per-trial data) to --out.
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { createServer } from "http";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { buildSwiftHelper } from "./swift-helper";

type Args = Record<string, string>;
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) out[a.slice(2)] = "1";
      else { out[a.slice(2)] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const UDID = args.udid ?? process.env.UDID ?? "";
if (!UDID) {
  console.error("bench-stream: pass --udid <simulator udid> (or UDID=...)");
  process.exit(2);
}
const KIND = args.kind ?? "serve-sim"; // serve-sim | baguette | browser | none
const BASE = args.base ?? "";
const CODEC = args.codec ?? "avcc"; // serve-sim: avcc | mjpeg
const LABEL = args.label ?? KIND;
const PAGE_PORT = Number(args["page-port"] ?? 4180);
const TARGET_PORT = Number(args.port ?? (BASE ? new URL(BASE).port : 0)); // CPU is sampled for this listener's process tree
const TRIALS = Number(args.trials ?? 20);
const ANIM_MS = Number(args["anim-ms"] ?? 5000);
const STIMULUS = args.stimulus ?? "page"; // page | tap
const WS_URL = args.ws ?? ""; // serve-sim HID ws (tap stimulus)
const OUT = args.out;
const FLIP = args.flip ?? "noise"; // noise | square — what each latency trial changes
const ANIM_KIND = args.anim ?? "noise"; // noise | scroll — sustained-animation content

const now = () => performance.timeOrigin + performance.now();
const dbg = (...a: unknown[]) => { if (process.env.BENCH_DEBUG) console.error(`[bench ${new Date().toISOString().slice(17, 23)}]`, ...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Stimulus page ──────────────────────────────────────────────────────────
// Full-screen canvas of 8px noise with a large solid centre square that
// alternates red/blue on every flip, so the native probe can confirm the
// change by colour and every flip is a high-entropy full-screen update.
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{position:fixed;inset:0;width:100vw;height:100vh;touch-action:none}</style></head>
<body><canvas id=c></canvas><script>
const c=document.getElementById('c');const x=c.getContext('2d');let n=0,anim=false;
function size(){c.width=innerWidth;c.height=innerHeight}size();addEventListener('resize',size);
const Q=new URLSearchParams(location.search),FLIP=Q.get('flip')||'noise',ANIM=Q.get('anim')||'noise';let sy=0;
function noise(){const w=c.width,h=c.height,s=8;for(let y=0;y<h;y+=s)for(let i=0;i<w;i+=s){x.fillStyle='hsl('+((Math.random()*360)|0)+',80%,'+((30+Math.random()*40)|0)+'%)';x.fillRect(i,y,s,s)}}
function text(){const w=c.width,h=c.height;x.fillStyle='#fff';x.fillRect(0,0,w,h);const rh=44,first=Math.floor(sy/rh);
for(let r=first;r*rh-sy<h;r++){const y=r*rh-sy;x.fillStyle='hsl('+(r*37%360)+',70%,55%)';x.fillRect(12,y+8,28,28);x.fillStyle='#111';x.font='15px -apple-system';x.fillText('Row '+r+' — The quick brown fox jumps over the lazy dog',50,y+22);x.fillStyle='#888';x.font='12px -apple-system';x.fillText('Subtitle '+(r*7919%1000),50,y+38);x.fillStyle='#ddd';x.fillRect(50,y+rh-1,w,1)}}
function square(){const w=c.width,h=c.height;x.fillStyle=n%2?'#0000ff':'#ff0000';x.fillRect(w*.2,h*.3,w*.6,h*.4);x.fillStyle='#fff';x.font='bold 40px -apple-system';x.fillText(String(n),w*.25,h*.36)}
function draw(kind){kind=kind||FLIP;if(kind==='noise')noise();else if(kind==='scroll'){sy+=6;text();n++;return}else{if(!n)text()}square();n++}
let ws;function conn(){ws=new WebSocket('ws://'+location.host+'/ctl?vis='+document.visibilityState);ws.onmessage=e=>{const m=JSON.parse(e.data);
if(m.cmd==='flip'){draw();requestAnimationFrame(()=>ws.send(JSON.stringify({painted:performance.timeOrigin+performance.now(),n})))}
if(m.cmd==='goto'){location.replace(m.url)}
if(m.cmd==='anim'){anim=m.on;if(anim)requestAnimationFrame(loop)}};ws.onclose=()=>setTimeout(conn,500)}
document.addEventListener('visibilitychange',()=>{ws&&ws.close()});
function loop(){if(!anim)return;draw(ANIM);requestAnimationFrame(loop)}
c.addEventListener('touchstart',e=>{e.preventDefault();draw();ws&&ws.readyState===1&&ws.send(JSON.stringify({touched:performance.timeOrigin+performance.now()}))},{passive:false});
c.addEventListener('mousedown',()=>draw());
text();draw();conn();
</script></body></html>`;

let pageSocket: WebSocket | null = null;
const pageEvents: Array<{ t: number; msg: any }> = [];
function startPageServer(): Promise<void> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(PAGE);
  });
  const wss = new WebSocketServer({ server, path: "/ctl" });
  wss.on("connection", (ws, req) => {
    // Background Safari tabs from earlier runs reconnect too; only drive the
    // visible one. Reusing it (instead of opening a tab per run) keeps Safari
    // from jettisoning pages once dozens of canvas tabs pile up.
    if (!req.url?.includes("vis=visible")) { ws.close(); return; }
    pageSocket = ws;
    ws.on("message", (d) => pageEvents.push({ t: now(), msg: JSON.parse(String(d)) }));
  });
  return new Promise((r) => server.listen(PAGE_PORT, "127.0.0.1", () => r()));
}
const sendPage = (msg: object) => pageSocket?.send(JSON.stringify(msg));

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));

// ── Native probe ───────────────────────────────────────────────────────────
type ProbeFrame = { t: number; px: number };
const probeFrames: ProbeFrame[] = [];
function startProbe(): ChildProcess {
  const bin = buildSwiftHelper(join(BENCH_DIR, "native-probe.swift"));
  const p = spawn(bin, [UDID], { stdio: ["ignore", "pipe", "inherit"] });
  let buf = "";
  p.stdout!.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = /^F ([\d.]+) \S+ ([0-9a-f]+)/.exec(line);
      if (m) probeFrames.push({ t: Number(m[1]), px: parseInt(m[2]!, 16) });
    }
  });
  return p;
}
// Probe pixel is BGRA little-endian → 0xAARRGGBB.
const probeClass = (px: number) => classify((px >> 16) & 0xff, (px >> 8) & 0xff, px & 0xff);

// ── Stream clients ─────────────────────────────────────────────────────────
// Every received frame is timestamped on arrival and also fed to a
// VideoToolbox/ImageIO decoder (frame-decoder.swift) that reports its centre
// pixel. Results come back in input order, so the n-th line belongs to the
// n-th received frame; a frame counts as "changed" when its centre colour
// (the red/blue square) differs from the previous one. The decoder's own
// delay never enters the measurement.
type ClientFrame = { t: number; bytes: number; changed: boolean; color: string };
const clientFrames: ClientFrame[] = [];
let clientFirstFrameAt = 0;

function classify(r: number, g: number, b: number): string {
  if (r > 150 && b < 100 && g < 100) return "red";
  if (b > 150 && r < 100 && g < 100) return "blue";
  return "other";
}

class CentreDecoder {
  private proc: ChildProcess;
  private pending: ClientFrame[] = [];
  private out = "";
  private last = "";
  private sawConfig = false;
  constructor(private readonly kind: "h264" | "mjpeg") {
    const bin = buildSwiftHelper(join(BENCH_DIR, "frame-decoder.swift"));
    this.proc = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
    this.proc.stdin!.on("error", () => {});
    this.proc.stdout!.on("data", (d: Buffer) => {
      this.out += d.toString();
      let i;
      while ((i = this.out.indexOf("\n")) >= 0) {
        const [r, g, b] = this.out.slice(0, i).split(" ").map(Number);
        this.out = this.out.slice(i + 1);
        const f = this.pending.shift();
        if (!f) continue;
        f.color = Number.isFinite(r) ? classify(r!, g!, b!) : "undecodable";
        f.changed = this.last !== "" && f.color !== this.last && (f.color === "red" || f.color === "blue");
        if (f.color === "red" || f.color === "blue") this.last = f.color;
      }
    });
  }
  private write(kind: number, payload: Uint8Array) {
    const head = Buffer.alloc(5);
    head.writeUInt32BE(payload.length, 0);
    head[4] = kind;
    this.proc.stdin!.write(Buffer.concat([head, payload]));
  }
  config(avcc: Uint8Array) { this.sawConfig = true; this.write(1, avcc); }
  push(t: number, bytes: number, encoded: Uint8Array) {
    const f: ClientFrame = { t, bytes, changed: false, color: "" };
    clientFrames.push(f);
    if (!clientFirstFrameAt) clientFirstFrameAt = t;
    if (this.kind === "h264" && !this.sawConfig) { f.color = "undecodable"; return; }
    this.pending.push(f);
    this.write(this.kind === "h264" ? 2 : 3, encoded);
  }
  close() { this.proc.kill(); }
}

/** Shared handling for [tag][payload] chunks (serve-sim AVCC and baguette). */
function makeAvccSink() {
  const dec = new CentreDecoder("h264");
  return {
    dec,
    chunk(t: number, tag: number, payload: Uint8Array) {
      if (tag === 0x01) dec.config(Buffer.from(payload));
      else if (tag === 0x02 || tag === 0x03) dec.push(t, payload.length, Buffer.from(payload));
    },
  };
}
const decoders: CentreDecoder[] = [];
let baguetteSocket: WebSocket | null = null;

/** serve-sim `/stream.avcc`: [u32 BE len][tag][payload]. */
async function serveSimAvcc(base: string, signal: AbortSignal) {
  const res = await fetch(`${base}/stream.avcc`, { signal });
  const reader = res.body!.getReader();
  const sink = makeAvccSink();
  decoders.push(sink.dec);
  let pending = new Uint8Array(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const t = now();
    const merged = new Uint8Array(pending.length + value.length);
    merged.set(pending); merged.set(value, pending.length);
    let off = 0;
    while (merged.length - off >= 5) {
      const len = new DataView(merged.buffer, merged.byteOffset + off).getUint32(0);
      if (merged.length - off < 4 + len) break;
      sink.chunk(t, merged[off + 4]!, merged.subarray(off + 5, off + 4 + len));
      off += 4 + len;
    }
    pending = merged.slice(off);
  }
}

/** serve-sim `/stream.mjpeg`: multipart with Content-Length per part. */
async function serveSimMjpeg(base: string, signal: AbortSignal) {
  const res = await fetch(`${base}/stream.mjpeg`, { signal });
  const reader = res.body!.getReader();
  const dec = new CentreDecoder("mjpeg");
  decoders.push(dec);
  let buf = Buffer.alloc(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const t = now();
    buf = Buffer.concat([buf, Buffer.from(value)]);
    for (;;) {
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd < 0) break;
      const head = buf.subarray(0, headEnd).toString("latin1");
      const m = /Content-Length:\s*(\d+)/i.exec(head);
      if (!m) { buf = buf.subarray(headEnd + 4); continue; }
      const len = Number(m[1]);
      if (buf.length < headEnd + 4 + len) break;
      dec.push(t, len, Buffer.from(buf.subarray(headEnd + 4, headEnd + 4 + len)));
      buf = buf.subarray(headEnd + 4 + len);
    }
  }
}

/**
 * baguette `/simulators/<udid>/stream?format=avcc|mjpeg` WebSocket. One binary
 * message per frame: `[tag][payload]` for AVCC (0x01 config, 0x02 key,
 * 0x03 delta, 0x04 JPEG seed); MJPEG messages are bare JPEGs.
 */
async function baguetteWs(url: string, signal: AbortSignal) {
  const ws = new WebSocket(url);
  baguetteSocket = ws;
  // Without a listener a failed handshake is an uncaught EventEmitter error.
  const closed = new Promise<void>((resolve, reject) => {
    ws.on("close", () => resolve());
    ws.on("error", (e) => {
      console.error(`bench-stream: baguette stream WebSocket ${url} failed: ${e.message}`);
      reject(e);
    });
  });
  ws.binaryType = "nodebuffer";
  signal.addEventListener("abort", () => ws.close());
  const jpeg = new URL(url).searchParams.get("format") !== "avcc";
  const sink = jpeg ? null : makeAvccSink();
  const dec = sink?.dec ?? new CentreDecoder("mjpeg");
  decoders.push(dec);
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return;
    const t = now();
    if (sink) sink.chunk(t, data[0]!, data.subarray(1));
    else dec.push(t, data.length, data);
  });
  await closed;
}


/**
 * Real browser (Chromium via playwright-core, headed so WebCodecs can use
 * hardware H.264 decode). Hooks CanvasRenderingContext2D.drawImage on the large
 * stream canvas and polls large <img> elements (MJPEG) on rAF, reporting each
 * painted frame's time and centre colour — i.e. decode + paint is included.
 */
async function browserClient(pageUrl: string, signal: AbortSignal) {
  const pw = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
  const browser = await pw.chromium.launch({
    headless: false,
    args: [
      "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling", "--window-size=900,1000", "--window-position=0,0",
    ],
  });
  signal.addEventListener("abort", () => void browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  let last = "";
  await page.exposeFunction("__benchFrame", (t: number, r: number, g: number, b: number) => {
    const color = classify(r, g, b);
    const changed = last !== "" && color !== last && (color === "red" || color === "blue");
    if (color === "red" || color === "blue") last = color;
    clientFrames.push({ t, bytes: 0, changed, color });
    if (!clientFirstFrameAt) clientFirstFrameAt = t;
  });
  await page.addInitScript(() => {
    const now = () => performance.timeOrigin + performance.now();
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const pctx = probe.getContext("2d", { willReadFrequently: true })!;
    const orig = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...a: any[]) {
      (orig as any).apply(this, a);
      const c = this.canvas;
      if (c === probe || c.width * c.height < 200_000) return;
      const t = now();
      const d = this.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
      (window as any).__benchFrame(t, d[0], d[1], d[2]);
    } as any;
    const seen = new WeakMap<HTMLImageElement, string>();
    const poll = () => {
      for (const img of Array.from(document.images)) {
        if (img.naturalWidth * img.naturalHeight < 200_000 || !img.complete) continue;
        if (seen.get(img) === img.currentSrc) continue;
        seen.set(img, img.currentSrc);
        (orig as any).call(pctx, img, img.naturalWidth >> 1, img.naturalHeight >> 1, 1, 1, 0, 0, 1, 1);
        const d = pctx.getImageData(0, 0, 1, 1).data;
        (window as any).__benchFrame(now(), d[0], d[1], d[2]);
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
  await page.goto(pageUrl);
  await new Promise((r) => signal.addEventListener("abort", r));
}

// ── CPU sampling ───────────────────────────────────────────────────────────
function treePids(root: number): number[] {
  const out = execFileSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" });
  const kids = new Map<number, number[]>();
  for (const line of out.trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!kids.has(ppid!)) kids.set(ppid!, []);
    kids.get(ppid!)!.push(pid!);
  }
  const all = [root];
  for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]!) ?? []));
  return all;
}
function listenerPid(port: number): number {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    return Number(out.trim().split("\n")[0]);
  } catch { return 0; }
}
function cpuSeconds(pids: number[]): number {
  if (!pids.length) return 0;
  const out = execFileSync("ps", ["-o", "time=", "-p", pids.join(",")], { encoding: "utf8" });
  let total = 0;
  for (const line of out.trim().split("\n")) {
    const parts = line.trim().split(":").map(Number); // [h:]m:s.ss
    total += parts.reduce((acc, v) => acc * 60 + v, 0);
  }
  return total;
}
/** CPU% (100 = one core) of the target's process tree over `fn`. */
async function measureCpu<T>(rootPid: number, fn: () => Promise<T>): Promise<{ cpu: number; result: T }> {
  const pids = rootPid ? treePids(rootPid) : [];
  const c0 = cpuSeconds(pids); const t0 = now();
  const result = await fn();
  const c1 = cpuSeconds(pids); const t1 = now();
  return { cpu: pids.length ? ((c1 - c0) / ((t1 - t0) / 1000)) * 100 : NaN, result };
}

// ── Stats ──────────────────────────────────────────────────────────────────
function stats(xs: number[]) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { n: 0, p50: NaN, p95: NaN, mean: NaN, min: NaN, max: NaN };
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {
    n: s.length,
    p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
    min: +s[0]!.toFixed(1), max: +s[s.length - 1]!.toFixed(1),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function sendTap(ws: WebSocket) {
  if (KIND === "baguette") {
    ws.send(JSON.stringify({ type: "touch1-down", x: 0.5, y: 0.5, width: 1, height: 1 }));
    ws.send(JSON.stringify({ type: "touch1-up", x: 0.5, y: 0.5, width: 1, height: 1 }));
    return;
  }
  const msg = (o: object) => Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify(o))]);
  ws.send(msg({ type: "begin", x: 0.5, y: 0.5 }));
  ws.send(msg({ type: "end", x: 0.5, y: 0.5 }));
}

async function main() {
  await startPageServer();
  const probe = startProbe();
  const pageUrl = `http://127.0.0.1:${PAGE_PORT}/?flip=${FLIP}&anim=${ANIM_KIND}`;
  for (let i = 0; i < 20 && !pageSocket; i++) await sleep(100);
  dbg("existing page:", !!pageSocket);
  const stale = pageSocket;
  if (stale) sendPage({ cmd: "goto", url: pageUrl });
  else execFileSync("xcrun", ["simctl", "openurl", UDID, pageUrl]);
  for (let i = 0; i < 100 && (!pageSocket || pageSocket === stale); i++) await sleep(100);
  if (pageSocket === stale) pageSocket = null;
  if (!pageSocket) throw new Error("stimulus page never connected (is Safari foreground?)");
  dbg("page connected");
  sendPage({ cmd: "anim", on: false });
  await sleep(1500);

  const abort = new AbortController();
  const t0Connect = now();
  if (KIND === "serve-sim") {
    void (CODEC === "mjpeg" ? serveSimMjpeg(BASE, abort.signal) : serveSimAvcc(BASE, abort.signal)).catch(() => {});
  } else if (KIND === "baguette") {
    void baguetteWs(BASE, abort.signal).catch(() => {});
  } else if (KIND === "browser") {
    void browserClient(BASE, abort.signal).catch((e) => console.error(e));
  }
  for (let i = 0; i < 300 && KIND !== "none" && !clientFirstFrameAt; i++) await sleep(50);
  dbg("first frame", clientFirstFrameAt);
  const timeToFirstFrame = clientFirstFrameAt ? clientFirstFrameAt - t0Connect : NaN;
  await sleep(1500);

  let hid: WebSocket | null = null;
  if (STIMULUS === "tap" && KIND === "baguette") {
    // baguette takes input as JSON text on the stream socket.
    hid = baguetteSocket;
  } else if (STIMULUS === "tap") {
    hid = new WebSocket(WS_URL);
    await new Promise((r, j) => { hid!.on("open", r); hid!.on("error", j); });
    await sleep(300);
  }

  const rootPid = TARGET_PORT ? listenerPid(TARGET_PORT) : 0;

  // Idle CPU.
  const idle = await measureCpu(rootPid, () => sleep(3000));

  // Latency trials.
  const trials: Array<{ t0: number; native: number; client: number; page: number; frames: number[][] }> = [];
  for (let i = 0; i < TRIALS; i++) {
    const flipIndex = i; // page n increments per draw; parity decides colour
    const before = { probe: probeFrames.length, client: clientFrames.length, page: pageEvents.length };
    const t0 = now();
    if (hid) await sendTap(hid); else sendPage({ cmd: "flip" });
    await sleep(700 + Math.random() * 200);
    const pg = pageEvents.slice(before.page).find((e) => e.msg.painted || e.msg.touched);
    // First framebuffer update whose centre colour differs from the frame
    // shown before the stimulus.
    const prevPx = probeFrames[before.probe - 1]?.px;
    const prevClass = prevPx == null ? "" : probeClass(prevPx);
    const pf2 = probeFrames.slice(before.probe).find((f) => f.t > t0 && probeClass(f.px) !== "other" && probeClass(f.px) !== prevClass);
    const cf = clientFrames.slice(before.client).find((f) => f.changed && f.t > t0);
    void flipIndex;
    const windowFrames = clientFrames.slice(before.client).map((f) => [Math.round(f.t - t0), f.bytes, f.changed ? 1 : 0]);
    trials.push({
      t0,
      frames: windowFrames,
      native: pf2 ? pf2.t - t0 : NaN,
      client: cf ? cf.t - t0 : NaN,
      page: pg ? (pg.msg.painted ?? pg.msg.touched) - t0 : NaN,
    });
  }

  dbg("trials done");
  // Sustained animation.
  const animStartClient = clientFrames.length;
  const animStartProbe = probeFrames.length;
  sendPage({ cmd: "anim", on: true });
  await sleep(500);
  const a0 = now(); const ci0 = clientFrames.length; const pi0 = probeFrames.length;
  const anim = await measureCpu(rootPid, () => sleep(ANIM_MS));
  const a1 = now();
  const animFrames = clientFrames.slice(ci0).filter((f) => f.t <= a1);
  const animProbe = probeFrames.slice(pi0).filter((f) => f.t <= a1);
  sendPage({ cmd: "anim", on: false });
  void animStartClient; void animStartProbe;

  // Inter-frame gap jitter on the client during animation.
  const gaps: number[] = [];
  for (let i = 1; i < animFrames.length; i++) gaps.push(animFrames[i]!.t - animFrames[i - 1]!.t);

  abort.abort();
  for (const d of decoders) d.close();
  if (hid !== baguetteSocket) hid?.close();
  probe.kill();

  const secs = (a1 - a0) / 1000;
  const result = {
    label: LABEL, kind: KIND, flip: FLIP, animKind: ANIM_KIND, codec: KIND === "serve-sim" ? CODEC : args["baguette-format"] ?? "", stimulus: STIMULUS,
    timeToFirstFrameMs: +timeToFirstFrame.toFixed(1),
    latency: {
      nativeMs: stats(trials.map((t) => t.native)),
      clientMs: stats(trials.map((t) => t.client)),
      overheadMs: stats(trials.map((t) => t.client - t.native)),
      pagePaintMs: stats(trials.map((t) => t.page)),
      missed: trials.filter((t) => !Number.isFinite(t.client)).length,
    },
    anim: {
      sourceFps: +(animProbe.length / secs).toFixed(1),
      clientFps: +(animFrames.length / secs).toFixed(1),
      bytesPerFrame: Math.round(animFrames.reduce((a, f) => a + f.bytes, 0) / Math.max(1, animFrames.length)),
      mbps: +((animFrames.reduce((a, f) => a + f.bytes, 0) * 8) / secs / 1e6).toFixed(2),
      gapMs: stats(gaps),
    },
    diag: { colors: clientFrames.reduce((m: Record<string, number>, f) => (m[f.color || "undecoded"] = (m[f.color || "undecoded"] ?? 0) + 1, m), {}), probeFrames: probeFrames.length, clientFrames: clientFrames.length, pageEvents: pageEvents.length },
    cpu: { idlePct: +idle.cpu.toFixed(1), animPct: +anim.cpu.toFixed(1), pid: rootPid },
    trials,
  };
  const json = JSON.stringify(result, null, 2);
  if (OUT) writeFileSync(OUT, json);
  const { trials: _t, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
