#!/usr/bin/env bun
// Fetch OSM way geometries + NED10m elevations and emit trail waypoint arrays.

type LL = [number, number]; // [lat, lon]

async function overpass(query: string): Promise<any> {
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "serve-sim trail builder",
    },
    body: new URLSearchParams({ data: query }).toString(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function elevations(coords: LL[], dataset = "ned10m"): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < coords.length; i += 90) {
    const batch = coords.slice(i, i + 90);
    const locs = batch.map(([lat, lon]) => `${lat.toFixed(6)},${lon.toFixed(6)}`).join("|");
    const url = `https://api.opentopodata.org/v1/${dataset}?locations=${locs}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`opentopodata ${res.status}`);
    const data: any = await res.json();
    for (const r of data.results) out.push(r.elevation || 0.0);
    await sleep(1100);
  }
  return out;
}

function haversine(a: LL, b: LL): number {
  const R = 6371000;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const lon1 = (a[1] * Math.PI) / 180;
  const lon2 = (b[1] * Math.PI) / 180;
  const h =
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function resample(points: LL[], n: number): LL[] {
  if (points.length <= n) return points;
  const cum = [0.0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[cum.length - 1] + haversine(points[i - 1], points[i]));
  }
  const total = cum[cum.length - 1];
  const closed = points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1];
  const out: LL[] = [];
  for (let i = 0; i < n; i++) {
    const t = closed ? (i * total) / n : (i * total) / (n - 1);
    let lo = 0;
    let hi = cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= t) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    const f = span === 0 ? 0 : (t - cum[lo]) / span;
    const a = points[lo];
    const b = points[hi];
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

function fmt(points: LL[], alts: number[], indent = "  "): string {
  return points
    .map(([lat, lon], i) => `${indent}{ lat: ${lat.toFixed(5)}, lng: ${lon.toFixed(5)}, alt: ${Math.round(alts[i])} },`)
    .join("\n");
}

function near(p: LL, q: LL, tol = 20): boolean {
  return haversine(p, q) < tol;
}

function stitch(segments: LL[][], tol = 20): LL[] {
  if (!segments.length) return [];
  const used = new Array(segments.length).fill(false);
  let chain: LL[] = [...segments[0]];
  used[0] = true;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < segments.length; i++) {
      if (used[i]) continue;
      const seg = segments[i];
      if (near(chain[chain.length - 1], seg[0], tol)) {
        chain.push(...seg.slice(1));
        used[i] = true;
        changed = true;
      } else if (near(chain[chain.length - 1], seg[seg.length - 1], tol)) {
        chain.push(...seg.slice(0, -1).reverse());
        used[i] = true;
        changed = true;
      } else if (near(chain[0], seg[seg.length - 1], tol)) {
        chain = [...seg, ...chain.slice(1)];
        used[i] = true;
        changed = true;
      } else if (near(chain[0], seg[0], tol)) {
        chain = [...[...seg].reverse(), ...chain.slice(1)];
        used[i] = true;
        changed = true;
      }
    }
  }
  return chain;
}

const log = (msg: string) => process.stderr.write(msg + "\n");

const geomToLL = (el: any): LL[] => el.geometry.map((p: any) => [p.lat, p.lon] as LL);

// 1. Apple Park ring road
log("Apple Park...");
let r = await overpass("[out:json];way(518104809);out geom;");
const ap: LL[] = geomToLL(r.elements[0]);
const ap_rs = resample(ap, 16);
const ap_alt = await elevations(ap_rs);

// 2. Golden Gate Bridge — concat S->N and N->S to make a closed there-and-back loop
log("Golden Gate...");
r = await overpass("[out:json];(way(537838948);way(595194543););out geom;");
const ways: Record<number, LL[]> = {};
for (const el of r.elements) ways[el.id] = geomToLL(el);
const sn = ways[537838948];
const ns = ways[595194543];
const gg = [...sn, ...ns.slice(1)];
const gg_rs = resample(gg, 18);
function bridgeAlt(lat: number): number {
  const s = 37.80690;
  const n = 37.82620;
  const t = (lat - s) / (n - s);
  return 30 + 37 * Math.sin(Math.max(0, Math.min(1, t)) * Math.PI);
}
const gg_alt = gg_rs.map(([lat]) => bridgeAlt(lat));

// 3. Mt Tam — Matt Davis (Stinson→Pantoll) + Steep Ravine (Pantoll→Stinson) classic loop.
log("Mt Tam...");
r = await overpass(`[out:json];
(
  way["name"="Matt Davis Trail"];
  way["name"="Steep Ravine Trail"];
);out geom;`);
const groups: Record<string, LL[][]> = { "Matt Davis Trail": [], "Steep Ravine Trail": [] };
for (const el of r.elements) {
  const name = el.tags?.name;
  if (name in groups) groups[name].push(geomToLL(el));
}
const md = stitch(groups["Matt Davis Trail"]);
const sr = stitch(groups["Steep Ravine Trail"]);
log(`  MD pts=${md.length} ${JSON.stringify(md[0])}->${JSON.stringify(md[md.length - 1])}`);
log(`  SR pts=${sr.length} ${JSON.stringify(sr[0])}->${JSON.stringify(sr[sr.length - 1])}`);
const tam_chain = stitch([md, sr], 1000);
log(`  Tam loop pts=${tam_chain.length}, closed=${near(tam_chain[0], tam_chain[tam_chain.length - 1], 1500)}`);
const tam_rs = resample(tam_chain, 22);
const tam_alt = await elevations(tam_rs);

// 4. Reservoir track
log("Reservoir...");
r = await overpass("[out:json];way(179679714);out geom;");
const cp: LL[] = geomToLL(r.elements[0]);
const cp_rs = resample(cp, 18);
const cp_alt = await elevations(cp_rs);

// 5. PCH — Pacifica section through Devil's Slide tunnel.
log("PCH...");
r = await overpass(`[out:json][timeout:60];
(
  way["ref"="CA 1"](37.5400,-122.5300,37.6200,-122.4700);
  way["name"="Cabrillo Highway"](37.5400,-122.5300,37.6200,-122.4700);
);out geom;`);
const hwy_segs: LL[][] = r.elements.map(geomToLL);
log(`  highway segments: ${hwy_segs.length}`);
let remaining = [...hwy_segs];
const chains: LL[][] = [];
while (remaining.length) {
  const seed = remaining.shift()!;
  const chain = stitch([seed, ...remaining]);
  chains.push(chain);
  const cs = new Set(chain.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`));
  const newRemaining: LL[][] = [];
  for (const seg of remaining) {
    const mid = seg[Math.floor(seg.length / 2)];
    const key = `${mid[0].toFixed(5)},${mid[1].toFixed(5)}`;
    if (!cs.has(key)) newRemaining.push(seg);
  }
  if (newRemaining.length === remaining.length) break;
  remaining = newRemaining;
}
const hwy_chain = chains.length ? chains.reduce((a, b) => (a.length >= b.length ? a : b)) : [];
log(`  longest chain pts=${hwy_chain.length}`);
if (hwy_chain.length) {
  log(`    ${JSON.stringify(hwy_chain[0])} -> ${JSON.stringify(hwy_chain[hwy_chain.length - 1])}`);
}
const pch_loop = [...hwy_chain, ...[...hwy_chain].reverse().slice(1)];
const pch_rs = resample(pch_loop, 22);
const pch_alt = await elevations(pch_rs);

// Emit
console.log("// === Apple Park ===");
console.log(fmt(ap_rs, ap_alt));
console.log("// === Golden Gate ===");
console.log(fmt(gg_rs, gg_alt));
console.log("// === Mt Tam ===");
console.log(fmt(tam_rs, tam_alt));
console.log("// === Reservoir ===");
console.log(fmt(cp_rs, cp_alt));
console.log("// === PCH ===");
console.log(fmt(pch_rs, pch_alt));
