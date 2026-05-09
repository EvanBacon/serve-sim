import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TRAILS,
  pointAtDistance,
  prepareTrail,
  projectLatLng,
  unprojectMeters,
  defaultSpeed,
} from "../client/trails";

describe("projectLatLng / unprojectMeters", () => {
  test("round-trips lat/lng within 1mm", () => {
    const origin = { lat: 37.3349, lng: -122.009 };
    const target = { lat: 37.3402, lng: -122.0011 };
    const local = projectLatLng(target.lat, target.lng, origin);
    const back = unprojectMeters(local.x, local.z, origin);
    expect(Math.abs(back.lat - target.lat)).toBeLessThan(1e-7);
    expect(Math.abs(back.lng - target.lng)).toBeLessThan(1e-7);
  });

  test("east of origin gives positive x, north gives negative z", () => {
    const origin = { lat: 0, lng: 0 };
    const east = projectLatLng(0, 0.001, origin);
    expect(east.x).toBeGreaterThan(0);
    expect(east.z).toBeCloseTo(0, 5);
    const north = projectLatLng(0.001, 0, origin);
    expect(north.x).toBeCloseTo(0, 5);
    expect(north.z).toBeLessThan(0);
  });
});

describe("prepareTrail", () => {
  test("rejects degenerate trails", () => {
    expect(() => prepareTrail({
      id: "x", name: "x", description: "", mode: "walk",
      waypoints: [{ lat: 0, lng: 0 }],
    })).toThrow();
  });

  test("produces densified points with monotonic arc length", () => {
    const trail = DEFAULT_TRAILS.find((t) => t.id === "golden-gate")!;
    const prepared = prepareTrail(trail);
    expect(prepared.points.length).toBeGreaterThan(trail.waypoints.length);
    for (let i = 1; i < prepared.points.length; i++) {
      expect(prepared.points[i]!.arc).toBeGreaterThanOrEqual(prepared.points[i - 1]!.arc);
    }
    // Bridge round-trip — span is ~2.7 km so a closed loop sits around 5 km.
    expect(prepared.totalDistance).toBeGreaterThan(3500);
    expect(prepared.totalDistance).toBeLessThan(7000);
  });

  test("every default trail is a closed loop", () => {
    for (const trail of DEFAULT_TRAILS) {
      expect(trail.loop).toBe(true);
    }
  });

  test("normalises altitude so y >= 0 and rawMin/Max preserved", () => {
    const trail = DEFAULT_TRAILS.find((t) => t.id === "tam-ridge")!;
    const prepared = prepareTrail(trail);
    // Real elevations from the Steep Ravine + Matt Davis loop.
    expect(prepared.rawMinAlt).toBe(121);
    expect(prepared.rawMaxAlt).toBe(450);
    for (const p of prepared.points) {
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
    // Climb is rawMaxAlt - rawMinAlt = 329m; densified peak should reach near it.
    expect(prepared.bounds.y[1]).toBeGreaterThan(300);
  });
});

describe("pointAtDistance", () => {
  test("returns endpoints for clamped values on non-loop trail", () => {
    // Synthetic non-loop trail — all defaults loop now.
    const prepared = prepareTrail({
      id: "synth", name: "synth", description: "", mode: "walk",
      waypoints: [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.001 },
        { lat: 0, lng: 0.002 },
      ],
    });
    const start = pointAtDistance(prepared, -100);
    expect(start).toEqual(prepared.points[0]!);
    const end = pointAtDistance(prepared, prepared.totalDistance + 100);
    expect(end).toEqual(prepared.points[prepared.points.length - 1]!);
  });

  test("wraps for loop trails", () => {
    const trail = DEFAULT_TRAILS.find((t) => t.id === "apple-park-loop")!;
    const prepared = prepareTrail(trail);
    const a = pointAtDistance(prepared, 100);
    const b = pointAtDistance(prepared, 100 + prepared.totalDistance);
    expect(a.lat).toBeCloseTo(b.lat, 6);
    expect(a.lng).toBeCloseTo(b.lng, 6);
  });

  test("interpolates lat/lng monotonically along the outbound half of golden-gate", () => {
    const trail = DEFAULT_TRAILS.find((t) => t.id === "golden-gate")!;
    const prepared = prepareTrail(trail);
    // Outbound leg heads south (route starts at the Marin anchorage).
    const samples = [];
    for (let i = 0; i <= 5; i++) {
      samples.push(pointAtDistance(prepared, (i / 10) * prepared.totalDistance));
    }
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.lat).toBeLessThanOrEqual(samples[i - 1]!.lat + 1e-6);
    }
  });
});

describe("defaultSpeed", () => {
  test("walk < run < cycle < drive", () => {
    expect(defaultSpeed("walk")).toBeLessThan(defaultSpeed("run"));
    expect(defaultSpeed("run")).toBeLessThan(defaultSpeed("cycle"));
    expect(defaultSpeed("cycle")).toBeLessThan(defaultSpeed("drive"));
  });
});
