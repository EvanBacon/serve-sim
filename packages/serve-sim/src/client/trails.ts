// Default trails for the location emulation panel + the math used to drive
// the 3D viz and the per-frame simctl location updates.
//
// Coordinates are real-world WGS-84 lat/lng; elevation is meters above sea
// level. We pre-densify each route with Catmull-Rom interpolation so both
// the renderer and the animator share a single arc-length-parameterised
// point list, which makes "advance N meters per frame" a trivial lookup.

export type TrailMode = "walk" | "run" | "cycle" | "drive";

export interface Waypoint {
  lat: number;
  lng: number;
  /** Altitude in meters. Optional; defaults to 0. */
  alt?: number;
}

export interface Trail {
  id: string;
  name: string;
  /** Short human-readable hint shown beneath the trail name. */
  description: string;
  /** Default transport mode the trail was authored for. */
  mode: TrailMode;
  waypoints: Waypoint[];
  /** True when the route returns to its starting point — animation loops. */
  loop?: boolean;
}

export interface RoutePoint {
  /** East offset from origin, meters. */
  x: number;
  /** Down (south is +z) offset from origin, meters. */
  z: number;
  /** Altitude in meters, relative to per-trail minimum (always >= 0). */
  y: number;
  /** Cumulative arc length along the route, meters (3D distance). */
  arc: number;
  /** Original geographic lat/lng — fed to `simctl location set`. */
  lat: number;
  lng: number;
}

export interface PreparedTrail {
  trail: Trail;
  origin: { lat: number; lng: number };
  points: RoutePoint[];
  totalDistance: number;
  /** AABB of the densified route, used to fit the camera. */
  bounds: { x: [number, number]; z: [number, number]; y: [number, number] };
  /** Min/max raw altitude in meters; for elevation labels. */
  rawMinAlt: number;
  rawMaxAlt: number;
}

const EARTH_RADIUS_M = 6_371_000;

/** Equirectangular projection of (lat,lng) to local meters around an origin. */
export function projectLatLng(
  lat: number,
  lng: number,
  origin: { lat: number; lng: number },
): { x: number; z: number } {
  const latRad = (origin.lat * Math.PI) / 180;
  const dLat = ((lat - origin.lat) * Math.PI) / 180;
  const dLng = ((lng - origin.lng) * Math.PI) / 180;
  return {
    x: dLng * Math.cos(latRad) * EARTH_RADIUS_M,
    z: -dLat * EARTH_RADIUS_M,
  };
}

/** Inverse of `projectLatLng` — local meters back to geographic. */
export function unprojectMeters(
  x: number,
  z: number,
  origin: { lat: number; lng: number },
): { lat: number; lng: number } {
  const latRad = (origin.lat * Math.PI) / 180;
  const dLat = (-z / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = (x / (EARTH_RADIUS_M * Math.cos(latRad))) * (180 / Math.PI);
  return { lat: origin.lat + dLat, lng: origin.lng + dLng };
}

interface RawPoint { x: number; z: number; y: number; rawAlt: number }

/** Centripetal Catmull-Rom interpolation between p1 and p2 using p0/p3 as
 *  tangent neighbours. Returns the position at parameter t in [0,1]. */
function catmullRom(
  p0: RawPoint, p1: RawPoint, p2: RawPoint, p3: RawPoint,
  t: number,
): RawPoint {
  const t2 = t * t;
  const t3 = t2 * t;
  const a = (v0: number, v1: number, v2: number, v3: number) =>
    0.5 * (
      (2 * v1) +
      (-v0 + v2) * t +
      (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
      (-v0 + 3 * v1 - 3 * v2 + v3) * t3
    );
  return {
    x: a(p0.x, p1.x, p2.x, p3.x),
    z: a(p0.z, p1.z, p2.z, p3.z),
    y: a(p0.y, p1.y, p2.y, p3.y),
    rawAlt: a(p0.rawAlt, p1.rawAlt, p2.rawAlt, p3.rawAlt),
  };
}

/** Resample a polyline at fixed segment length `step` (meters), smoothing
 *  with Catmull-Rom. Returns the densified raw points. */
function densify(
  raw: RawPoint[],
  step: number,
  closed: boolean,
): RawPoint[] {
  if (raw.length < 2) return raw.slice();

  const out: RawPoint[] = [];
  const n = raw.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const p0 = raw[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
    const p1 = raw[i % n]!;
    const p2 = raw[(i + 1) % n]!;
    const p3 = raw[closed ? (i + 2) % n : Math.min(n - 1, i + 2)]!;
    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const segLen = Math.hypot(dx, dz);
    const subdivisions = Math.max(2, Math.ceil(segLen / step));
    for (let s = 0; s < subdivisions; s++) {
      const t = s / subdivisions;
      out.push(catmullRom(p0, p1, p2, p3, t));
    }
  }
  if (!closed) out.push(raw[n - 1]!);
  return out;
}

export function prepareTrail(trail: Trail): PreparedTrail {
  if (trail.waypoints.length < 2) {
    throw new Error(`Trail ${trail.id} needs at least 2 waypoints`);
  }

  // Origin = arithmetic mean of waypoints. Equirectangular distortion is
  // negligible at the scales we care about (< few km).
  const origin = {
    lat: trail.waypoints.reduce((s, w) => s + w.lat, 0) / trail.waypoints.length,
    lng: trail.waypoints.reduce((s, w) => s + w.lng, 0) / trail.waypoints.length,
  };

  const rawAlts = trail.waypoints.map((w) => w.alt ?? 0);
  const rawMinAlt = Math.min(...rawAlts);
  const rawMaxAlt = Math.max(...rawAlts);

  const raw: RawPoint[] = trail.waypoints.map((w) => {
    const { x, z } = projectLatLng(w.lat, w.lng, origin);
    const rawAlt = w.alt ?? 0;
    return { x, z, y: rawAlt - rawMinAlt, rawAlt };
  });

  const dense = densify(raw, 8, !!trail.loop);

  // Build arc-length parameterised RoutePoints.
  const points: RoutePoint[] = [];
  let arc = 0;
  for (let i = 0; i < dense.length; i++) {
    const cur = dense[i]!;
    if (i > 0) {
      const prev = dense[i - 1]!;
      arc += Math.hypot(cur.x - prev.x, cur.z - prev.z, cur.y - prev.y);
    }
    const { lat, lng } = unprojectMeters(cur.x, cur.z, origin);
    // Catmull-Rom can undershoot the discrete min between waypoints; clamp so
    // the rendered ribbon never dips below the trail floor.
    const y = Math.max(0, cur.y);
    points.push({ x: cur.x, z: cur.z, y, arc, lat, lng });
  }

  // AABB
  let xmin = Infinity, xmax = -Infinity;
  let zmin = Infinity, zmax = -Infinity;
  let ymin = Infinity, ymax = -Infinity;
  for (const p of points) {
    if (p.x < xmin) xmin = p.x;
    if (p.x > xmax) xmax = p.x;
    if (p.z < zmin) zmin = p.z;
    if (p.z > zmax) zmax = p.z;
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }

  return {
    trail,
    origin,
    points,
    totalDistance: points[points.length - 1]!.arc,
    bounds: { x: [xmin, xmax], y: [ymin, ymax], z: [zmin, zmax] },
    rawMinAlt,
    rawMaxAlt,
  };
}

/** Lookup the route point at a given arc-length offset (meters), interpolating
 *  between the two flanking dense points. Wraps around for `loop` trails. */
export function pointAtDistance(p: PreparedTrail, distance: number): RoutePoint {
  const total = p.totalDistance;
  if (total === 0) return p.points[0]!;
  let d = distance;
  if (p.trail.loop) {
    d = ((d % total) + total) % total;
  } else {
    if (d <= 0) return p.points[0]!;
    if (d >= total) return p.points[p.points.length - 1]!;
  }

  // Binary search for the segment containing `d`.
  let lo = 0;
  let hi = p.points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (p.points[mid]!.arc <= d) lo = mid; else hi = mid;
  }
  const a = p.points[lo]!;
  const b = p.points[hi]!;
  const span = b.arc - a.arc;
  const t = span === 0 ? 0 : (d - a.arc) / span;
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    y: a.y + (b.y - a.y) * t,
    arc: d,
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

/** Default speed in meters / second for a transport mode. */
export function defaultSpeed(mode: TrailMode): number {
  switch (mode) {
    case "walk": return 1.4;
    case "run": return 3.0;
    case "cycle": return 5.5;
    case "drive": return 13.4;
  }
}

export function modeLabel(mode: TrailMode): string {
  switch (mode) {
    case "walk": return "Walk";
    case "run": return "Run";
    case "cycle": return "Cycle";
    case "drive": return "Drive";
  }
}

// ─── Default trails ───────────────────────────────────────────────────────
//
// Every default trail is a closed loop so playback cycles forever. Waypoints
// are sampled from OpenStreetMap way/relation geometries, then re-sampled at
// even arc-length spacing. Elevations come from USGS NED 10m (via
// OpenTopoData) so altitudes reflect real terrain — except the Golden Gate
// deck, which the DEM reads as water and we synthesize as the actual arch
// profile. To regenerate, see `scripts/build-trails.py`.

/** Apple Park perimeter ring road — OSM way 518104809. */
const APPLE_PARK_LOOP: Waypoint[] = [
  { lat: 37.33272, lng: -122.00833, alt: 49 },
  { lat: 37.33309, lng: -122.00735, alt: 48 },
  { lat: 37.33373, lng: -122.00663, alt: 49 },
  { lat: 37.33454, lng: -122.00627, alt: 49 },
  { lat: 37.33540, lng: -122.00633, alt: 49 },
  { lat: 37.33618, lng: -122.00679, alt: 45 },
  { lat: 37.33675, lng: -122.00759, alt: 45 },
  { lat: 37.33704, lng: -122.00861, alt: 46 },
  { lat: 37.33698, lng: -122.00969, alt: 48 },
  { lat: 37.33662, lng: -122.01066, alt: 48 },
  { lat: 37.33598, lng: -122.01138, alt: 49 },
  { lat: 37.33517, lng: -122.01174, alt: 50 },
  { lat: 37.33431, lng: -122.01169, alt: 50 },
  { lat: 37.33354, lng: -122.01122, alt: 50 },
  { lat: 37.33296, lng: -122.01042, alt: 51 },
  { lat: 37.33268, lng: -122.00940, alt: 50 },
];

/** Golden Gate Bridge round-trip — OSM ways 537838948 (S→N) + 595194543
 *  (N→S). Deck altitudes synthesized as a 30m → 67m → 30m arch since the DEM
 *  records water surface, not the bridge deck. */
const GOLDEN_GATE_BRIDGE: Waypoint[] = [
  { lat: 37.83212, lng: -122.48065, alt: 30 },
  { lat: 37.82937, lng: -122.47974, alt: 30 },
  { lat: 37.82649, lng: -122.47940, alt: 30 },
  { lat: 37.82362, lng: -122.47907, alt: 45 },
  { lat: 37.82074, lng: -122.47873, alt: 59 },
  { lat: 37.81786, lng: -122.47839, alt: 66 },
  { lat: 37.81498, lng: -122.47806, alt: 66 },
  { lat: 37.81211, lng: -122.47772, alt: 58 },
  { lat: 37.80923, lng: -122.47734, alt: 44 },
  { lat: 37.80949, lng: -122.47730, alt: 45 },
  { lat: 37.81236, lng: -122.47765, alt: 59 },
  { lat: 37.81524, lng: -122.47798, alt: 66 },
  { lat: 37.81812, lng: -122.47832, alt: 66 },
  { lat: 37.82100, lng: -122.47866, alt: 58 },
  { lat: 37.82387, lng: -122.47900, alt: 44 },
  { lat: 37.82675, lng: -122.47933, alt: 30 },
  { lat: 37.82963, lng: -122.47967, alt: 30 },
  { lat: 37.83233, lng: -122.48072, alt: 30 },
];

/** Mt Tam — Steep Ravine + Matt Davis loop from Stinson Beach. Stitched from
 *  OSM ways named "Steep Ravine Trail" and "Matt Davis Trail". ~330m gain. */
const TAM_RIDGE_HIKE: Waypoint[] = [
  { lat: 37.88664, lng: -122.62599, alt: 121 },
  { lat: 37.88887, lng: -122.62332, alt: 135 },
  { lat: 37.89115, lng: -122.62160, alt: 164 },
  { lat: 37.89353, lng: -122.61921, alt: 180 },
  { lat: 37.89466, lng: -122.61577, alt: 220 },
  { lat: 37.89631, lng: -122.61268, alt: 273 },
  { lat: 37.89917, lng: -122.61098, alt: 313 },
  { lat: 37.90166, lng: -122.60855, alt: 342 },
  { lat: 37.90199, lng: -122.60601, alt: 408 },
  { lat: 37.90339, lng: -122.60401, alt: 450 },
  { lat: 37.90662, lng: -122.60291, alt: 440 },
  { lat: 37.90971, lng: -122.60173, alt: 432 },
  { lat: 37.91213, lng: -122.60007, alt: 436 },
  { lat: 37.91439, lng: -122.59780, alt: 410 },
  { lat: 37.91285, lng: -122.59504, alt: 422 },
  { lat: 37.91274, lng: -122.59202, alt: 425 },
  { lat: 37.91500, lng: -122.59032, alt: 412 },
  { lat: 37.91637, lng: -122.58903, alt: 406 },
  { lat: 37.91481, lng: -122.58595, alt: 382 },
  { lat: 37.91740, lng: -122.58398, alt: 372 },
  { lat: 37.91642, lng: -122.58236, alt: 352 },
  { lat: 37.91481, lng: -122.58011, alt: 342 },
];

/** Stephanie & Fred Shuman Reservoir Running Track in Central Park —
 *  OSM way 179679714. Closed ~2.5km loop. */
const CENTRAL_PARK_RESERVOIR: Waypoint[] = [
  { lat: 40.78216, lng: -73.96254, alt: 37 },
  { lat: 40.78221, lng: -73.96098, alt: 36 },
  { lat: 40.78328, lng: -73.96010, alt: 36 },
  { lat: 40.78440, lng: -73.95930, alt: 36 },
  { lat: 40.78550, lng: -73.95848, alt: 36 },
  { lat: 40.78664, lng: -73.95774, alt: 36 },
  { lat: 40.78790, lng: -73.95764, alt: 36 },
  { lat: 40.78898, lng: -73.95792, alt: 36 },
  { lat: 40.78868, lng: -73.95951, alt: 37 },
  { lat: 40.78897, lng: -73.96112, alt: 36 },
  { lat: 40.78833, lng: -73.96250, alt: 37 },
  { lat: 40.78828, lng: -73.96416, alt: 37 },
  { lat: 40.78805, lng: -73.96573, alt: 36 },
  { lat: 40.78691, lng: -73.96636, alt: 36 },
  { lat: 40.78566, lng: -73.96665, alt: 36 },
  { lat: 40.78458, lng: -73.96608, alt: 36 },
  { lat: 40.78402, lng: -73.96459, alt: 36 },
  { lat: 40.78322, lng: -73.96334, alt: 37 },
];

/** Highway 1 through Pacifica up to Devil's Slide — out-and-back closed
 *  loop along OSM `ref=CA 1` ways. */
const PCH_PACIFICA: Waypoint[] = [
  { lat: 37.59659, lng: -122.50316, alt: 4 },
  { lat: 37.59555, lng: -122.50424, alt: 4 },
  { lat: 37.59452, lng: -122.50534, alt: 5 },
  { lat: 37.59329, lng: -122.50588, alt: 9 },
  { lat: 37.59212, lng: -122.50508, alt: 20 },
  { lat: 37.59100, lng: -122.50413, alt: 29 },
  { lat: 37.58974, lng: -122.50416, alt: 40 },
  { lat: 37.58870, lng: -122.50524, alt: 51 },
  { lat: 37.58745, lng: -122.50496, alt: 60 },
  { lat: 37.58627, lng: -122.50422, alt: 71 },
  { lat: 37.58539, lng: -122.50534, alt: 82 },
  { lat: 37.58505, lng: -122.50698, alt: 93 },
  { lat: 37.58539, lng: -122.50534, alt: 82 },
  { lat: 37.58627, lng: -122.50422, alt: 71 },
  { lat: 37.58745, lng: -122.50496, alt: 60 },
  { lat: 37.58870, lng: -122.50524, alt: 51 },
  { lat: 37.58974, lng: -122.50416, alt: 40 },
  { lat: 37.59100, lng: -122.50413, alt: 29 },
  { lat: 37.59212, lng: -122.50508, alt: 20 },
  { lat: 37.59329, lng: -122.50588, alt: 9 },
  { lat: 37.59452, lng: -122.50534, alt: 5 },
  { lat: 37.59555, lng: -122.50424, alt: 4 },
];

export const DEFAULT_TRAILS: Trail[] = [
  {
    id: "apple-park-loop",
    name: "Apple Park Loop",
    description: "Cupertino • flat ring road",
    mode: "walk",
    waypoints: APPLE_PARK_LOOP,
    loop: true,
  },
  {
    id: "golden-gate",
    name: "Golden Gate Crossing",
    description: "San Francisco • bridge round-trip",
    mode: "run",
    waypoints: GOLDEN_GATE_BRIDGE,
    loop: true,
  },
  {
    id: "tam-ridge",
    name: "Mt. Tam Ridge",
    description: "Stinson Beach • Steep Ravine + Matt Davis loop",
    mode: "walk",
    waypoints: TAM_RIDGE_HIKE,
    loop: true,
  },
  {
    id: "central-park",
    name: "Reservoir Loop",
    description: "Central Park • 2.5 km",
    mode: "run",
    waypoints: CENTRAL_PARK_RESERVOIR,
    loop: true,
  },
  {
    id: "pch-pacifica",
    name: "Pacific Coast Hwy",
    description: "Pacifica • Devil's Slide round-trip",
    mode: "drive",
    waypoints: PCH_PACIFICA,
    loop: true,
  },
];
