#!/usr/bin/env python3
"""Fetch OSM way geometries + NED10m elevations and emit trail waypoint arrays."""
import json, math, time, urllib.request, urllib.parse, sys

def overpass(query):
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter", data=data,
        headers={"User-Agent": "serve-sim trail builder"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def elevations(coords, dataset="ned10m"):
    """coords: list of (lat, lon). Returns list of elevation in meters."""
    out = []
    for i in range(0, len(coords), 90):
        batch = coords[i:i+90]
        locs = "|".join(f"{lat:.6f},{lon:.6f}" for lat, lon in batch)
        url = f"https://api.opentopodata.org/v1/{dataset}?locations={locs}"
        with urllib.request.urlopen(url, timeout=60) as r:
            data = json.loads(r.read())
        for res in data["results"]:
            out.append(res["elevation"] or 0.0)
        time.sleep(1.1)
    return out

def haversine(a, b):
    R = 6371000
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 2*R*math.asin(math.sqrt(h))

def resample(points, n):
    """Even-spaced resample of a polyline to n points (preserves closedness if input is)."""
    if len(points) <= n:
        return points
    cum = [0.0]
    for i in range(1, len(points)):
        cum.append(cum[-1] + haversine(points[i-1], points[i]))
    total = cum[-1]
    closed = points[0] == points[-1]
    out = []
    for i in range(n):
        t = i * total / n if closed else i * total / (n-1)
        # binary search
        lo, hi = 0, len(cum)-1
        while lo + 1 < hi:
            mid = (lo+hi)//2
            if cum[mid] <= t: lo = mid
            else: hi = mid
        span = cum[hi] - cum[lo]
        f = 0 if span == 0 else (t - cum[lo]) / span
        a, b = points[lo], points[hi]
        out.append((a[0] + (b[0]-a[0])*f, a[1] + (b[1]-a[1])*f))
    return out

def fmt(points, alts, indent="  "):
    lines = []
    for (lat, lon), alt in zip(points, alts):
        lines.append(f"{indent}{{ lat: {lat:.5f}, lng: {lon:.5f}, alt: {round(alt)} }},")
    return "\n".join(lines)

# 1. Apple Park ring road
print("Apple Park...", file=sys.stderr)
r = overpass("[out:json];way(518104809);out geom;")
ap = [(p["lat"], p["lon"]) for p in r["elements"][0]["geometry"]]
ap_rs = resample(ap, 16)
ap_alt = elevations(ap_rs)

# 2. Golden Gate Bridge — concat S->N and N->S to make a closed there-and-back loop
print("Golden Gate...", file=sys.stderr)
r = overpass("[out:json];(way(537838948);way(595194543););out geom;")
ways = {el["id"]: [(p["lat"], p["lon"]) for p in el["geometry"]] for el in r["elements"]}
sn = ways[537838948]
ns = ways[595194543]
# Both ways: 537838948 starts S (37.808) ends N (37.832); 595194543 starts N ends S
gg = sn + ns[1:]  # avoid duplicating the join point
gg_rs = resample(gg, 18)
# DEM gives water (0m) — synthesize bridge deck profile.
# Real bridge: anchorage decks ~30m, towers/mid-span ~67m above water.
def bridge_alt(lat):
    s, n = 37.80690, 37.82620
    t = (lat - s) / (n - s)
    # Smooth arch: low at endpoints, ~67m at midspan
    return 30 + 37 * math.sin(max(0, min(1, t)) * math.pi)
gg_alt = [bridge_alt(lat) for lat, _ in gg_rs]

def near(p, q, tol=20):
    return haversine(p, q) < tol

def stitch(segments, tol=20):
    if not segments: return []
    used = [False]*len(segments)
    chain = list(segments[0]); used[0]=True
    changed = True
    while changed:
        changed = False
        for i, seg in enumerate(segments):
            if used[i]: continue
            if near(chain[-1], seg[0], tol):
                chain.extend(seg[1:]); used[i]=True; changed=True
            elif near(chain[-1], seg[-1], tol):
                chain.extend(reversed(seg[:-1])); used[i]=True; changed=True
            elif near(chain[0], seg[-1], tol):
                chain = list(seg) + chain[1:]; used[i]=True; changed=True
            elif near(chain[0], seg[0], tol):
                chain = list(reversed(seg)) + chain[1:]; used[i]=True; changed=True
    return chain

# 3. Mt Tam — Matt Davis (Stinson→Pantoll) + Steep Ravine (Pantoll→Stinson) classic loop.
print("Mt Tam...", file=sys.stderr)
r = overpass('''[out:json];
(
  way["name"="Matt Davis Trail"];
  way["name"="Steep Ravine Trail"];
);out geom;''')
groups = {"Matt Davis Trail": [], "Steep Ravine Trail": []}
for el in r["elements"]:
    name = el["tags"].get("name")
    if name in groups:
        groups[name].append([(p["lat"], p["lon"]) for p in el["geometry"]])
md = stitch(groups["Matt Davis Trail"])
sr = stitch(groups["Steep Ravine Trail"])
print(f"  MD pts={len(md)} {md[0]}->{md[-1]}", file=sys.stderr)
print(f"  SR pts={len(sr)} {sr[0]}->{sr[-1]}", file=sys.stderr)
# MD ends at the Pantoll/Mtn Home end; SR shares Pantoll. We want a loop:
# Stinson(Dipsea junction) → Matt Davis → Pantoll → Steep Ravine → Stinson.
# Use a generous stitching tolerance to bridge minor gaps between named ways.
tam_chain = stitch([md, sr], tol=1000)
print(f"  Tam loop pts={len(tam_chain)}, closed={near(tam_chain[0], tam_chain[-1], 1500)}", file=sys.stderr)
tam_rs = resample(tam_chain, 22)
tam_alt = elevations(tam_rs)

# 4. Reservoir track
print("Reservoir...", file=sys.stderr)
r = overpass("[out:json];way(179679714);out geom;")
cp = [(p["lat"], p["lon"]) for p in r["elements"][0]["geometry"]]
cp_rs = resample(cp, 18)
cp_alt = elevations(cp_rs)

# 5. PCH — Pacifica section through Devil's Slide tunnel. Hwy 1 in OSM splits
# into many short ways with mixed ref tagging; stitch by ref and bbox, then keep
# the longest contiguous chain through Pacifica.
print("PCH...", file=sys.stderr)
r = overpass('''[out:json][timeout:60];
(
  way["ref"="CA 1"](37.5400,-122.5300,37.6200,-122.4700);
  way["name"="Cabrillo Highway"](37.5400,-122.5300,37.6200,-122.4700);
);out geom;''')
hwy_segs = [[(p["lat"], p["lon"]) for p in el["geometry"]] for el in r["elements"]]
print(f"  highway segments: {len(hwy_segs)}", file=sys.stderr)
# Stitch via repeated passes; some segments may be disjoint (interchanges).
remaining = list(hwy_segs)
chains = []
while remaining:
    seed = remaining.pop(0)
    chain = stitch([seed] + remaining)
    chains.append(chain)
    # Mark consumed: rebuild remaining by filtering anything fully inside the chain.
    cs = set((round(p[0],5), round(p[1],5)) for p in chain)
    new_remaining = []
    for seg in remaining:
        sample = (round(seg[len(seg)//2][0],5), round(seg[len(seg)//2][1],5))
        if sample not in cs:
            new_remaining.append(seg)
    if len(new_remaining) == len(remaining): break
    remaining = new_remaining
hwy_chain = max(chains, key=len) if chains else []
print(f"  longest chain pts={len(hwy_chain)}", file=sys.stderr)
if hwy_chain:
    print(f"    {hwy_chain[0]} -> {hwy_chain[-1]}", file=sys.stderr)
# Out-and-back closed loop: forward + reverse (skip duplicate endpoint).
pch_loop = hwy_chain + list(reversed(hwy_chain))[1:]
pch_rs = resample(pch_loop, 22)
pch_alt = elevations(pch_rs)

# Emit
print("// === Apple Park ===")
print(fmt(ap_rs, ap_alt))
print("// === Golden Gate ===")
print(fmt(gg_rs, gg_alt))
print("// === Mt Tam ===")
print(fmt(tam_rs, tam_alt))
print("// === Reservoir ===")
print(fmt(cp_rs, cp_alt))
print("// === PCH ===")
print(fmt(pch_rs, pch_alt))
