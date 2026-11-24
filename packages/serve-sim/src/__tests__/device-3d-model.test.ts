import { describe, expect, test } from "bun:test";
import {
  MAT_BACK,
  MAT_BUTTON,
  MAT_FRAME,
  MAT_FRONT,
  buildDeviceMesh,
  device3DModel,
  deviceKindFor,
  type DeviceKitChromeMetrics,
} from "../client/device-3d/model";

// Roughly an iPhone Pro chrome: body inset in the bezel image, side buttons
// overhanging the left and right edges.
const PHONE: DeviceKitChromeMetrics = {
  identifier: "phone11",
  body: { x: 10, y: 10, width: 420, height: 880 },
  screen: { x: 30, y: 30, width: 380, height: 840 },
  outerCornerRadius: 70,
  innerCornerRadius: 55,
  screenRadius: 55,
  buttons: [
    { frame: { x: 7, y: 200, width: 6, height: 40 } }, // action, left
    { frame: { x: 7, y: 280, width: 6, height: 70 } }, // volume up, left
    { frame: { x: 428, y: 300, width: 5, height: 110 } }, // side, right
    { frame: { x: 0, y: 0, width: 0, height: 0 } }, // empty frame, ignored
  ],
};

describe("deviceKindFor", () => {
  test("trusts the DeviceKit chrome id first", () => {
    expect(deviceKindFor("iphone", { width: 1, height: 1 }, "tablet5")).toBe("tablet");
    expect(deviceKindFor("ipad", { width: 1, height: 1 }, "phone11")).toBe("phone");
  });

  test("falls back to the device type, then the aspect ratio", () => {
    expect(deviceKindFor("ipad", { width: 400, height: 900 })).toBe("tablet");
    expect(deviceKindFor("iphone", { width: 1000, height: 1000 })).toBe("phone");
    expect(deviceKindFor(null, { width: 1206, height: 2622 })).toBe("phone");
    expect(deviceKindFor(null, { width: 2064, height: 2752 })).toBe("tablet");
  });
});

describe("device3DModel", () => {
  test("normalizes the chrome body to unit height and keeps proportions", () => {
    const m = device3DModel(PHONE, { width: 1206, height: 2622 }, "phone");
    expect(m.height).toBe(1);
    expect(m.width).toBeCloseTo(420 / 880, 6);
    expect(m.depth).toBeCloseTo((420 * 0.118) / 880, 6);
    expect(m.cornerRadius).toBeCloseTo(70 / 880, 6);
    expect(m.screen.halfWidth).toBeCloseTo(190 / 880, 6);
    expect(m.screen.halfHeight).toBeCloseTo(420 / 880, 6);
    expect(m.screen.x).toBeCloseTo(0, 6);
    expect(m.screen.y).toBeCloseTo(0, 6);
  });

  test("puts side buttons on the matching edge, visibly proud of the band", () => {
    const m = device3DModel(PHONE, { width: 1206, height: 2622 }, "phone");
    expect(m.buttons).toHaveLength(3);
    const [action, volume, side] = m.buttons;
    expect(action!.x).toBeLessThan(-m.width / 2);
    expect(volume!.x).toBeLessThan(-m.width / 2);
    expect(side!.x).toBeGreaterThan(m.width / 2);
    // Higher on the page = higher in object space (y up).
    expect(action!.y).toBeGreaterThan(volume!.y);
    // Overhang is at least 2.5 chrome points even when the chrome says less.
    const proud = side!.x + side!.sx / 4 - m.width / 2;
    expect(proud).toBeGreaterThanOrEqual(2.5 / 880 - 1e-9);
    for (const b of m.buttons) expect(b.sz).toBeCloseTo(m.depth * 0.5, 6);
  });

  test("keeps real DeviceKit buttons, whose frames straddle the body edge", () => {
    // phone11 (iPhone 18 Pro) and tablet5 (iPad Pro 13") as DeviceKit ships them.
    const phone11: DeviceKitChromeMetrics = {
      identifier: "phone11",
      body: { x: 9, y: 0, width: 436, height: 908 },
      screen: { x: 26, y: 17, width: 402, height: 874 },
      outerCornerRadius: 80,
      innerCornerRadius: 62,
      screenRadius: 61,
      buttons: [
        { frame: { x: 4, y: 160, width: 16, height: 34 } },
        { frame: { x: 4, y: 221, width: 16, height: 64 } },
        { frame: { x: 4, y: 300, width: 16, height: 64 } },
        { frame: { x: 432, y: 262, width: 16, height: 101 } },
      ],
    };
    const phone = device3DModel(phone11, { width: 1206, height: 2622 }, "phone");
    expect(phone.buttons).toHaveLength(4);
    expect(phone.buttons.slice(0, 3).every((b) => b.x < -phone.width / 2)).toBe(true);
    expect(phone.buttons[3]!.x).toBeGreaterThan(phone.width / 2);

    const tablet5: DeviceKitChromeMetrics = {
      identifier: "tablet5",
      body: { x: 0, y: 9, width: 1124, height: 1468 },
      screen: { x: 46, y: 55, width: 1032, height: 1376 },
      outerCornerRadius: 75,
      innerCornerRadius: 29,
      screenRadius: 29,
      buttons: [
        { frame: { x: 1111, y: 109, width: 16, height: 52 } },
        { frame: { x: 1111, y: 172, width: 16, height: 52 } },
        { frame: { x: 987, y: 6, width: 63, height: 16 } },
      ],
    };
    const tablet = device3DModel(tablet5, { width: 2064, height: 2752 }, "tablet");
    expect(tablet.buttons).toHaveLength(3);
    expect(tablet.buttons[0]!.x).toBeGreaterThan(tablet.width / 2);
    expect(tablet.buttons[1]!.x).toBeGreaterThan(tablet.width / 2);
    expect(tablet.buttons[2]!.y).toBeGreaterThan(tablet.height / 2);
    expect(tablet.buttons[2]!.sx).toBeGreaterThan(tablet.buttons[2]!.sy);
  });

  test("ignores button frames nowhere near an edge", () => {
    const inner = { ...PHONE, buttons: [{ frame: { x: 200, y: 400, width: 10, height: 40 } }] };
    expect(device3DModel(inner, { width: 1, height: 1 }, "phone").buttons).toEqual([]);
  });

  test("tablets are much thinner than phones", () => {
    const phone = device3DModel(PHONE, { width: 1, height: 1 }, "phone");
    const tablet = device3DModel(PHONE, { width: 1, height: 1 }, "tablet");
    expect(tablet.depth).toBeLessThan(phone.depth / 3);
  });

  test("builds a plain rounded slab when there is no chrome", () => {
    const m = device3DModel(null, { width: 2064, height: 2752 }, "tablet");
    expect(m.height).toBe(1);
    expect(m.width).toBeLessThan(1);
    expect(m.buttons).toEqual([]);
    expect(m.screen.halfWidth * 2).toBeLessThan(m.width);
    expect(m.screen.halfHeight * 2).toBeLessThan(1);
    // Landscape-reported sizes still give a portrait model (roll turns it).
    expect(device3DModel(null, { width: 2752, height: 2064 }, "tablet")).toEqual(m);
  });

  test("ignores degenerate chrome", () => {
    const broken = { ...PHONE, body: { x: 0, y: 0, width: 0, height: 0 } };
    expect(device3DModel(broken, { width: 1206, height: 2622 }, "phone").buttons).toEqual([]);
  });
});

describe("buildDeviceMesh", () => {
  test("produces valid indexed geometry with every material", () => {
    const mesh = buildDeviceMesh(device3DModel(PHONE, { width: 1, height: 1 }, "phone"));
    const vertexCount = mesh.vertices.length / 7;
    expect(Number.isInteger(vertexCount)).toBe(true);
    expect(vertexCount).toBeLessThan(65536);
    expect(mesh.indices.length % 3).toBe(0);
    expect(Math.max(...mesh.indices)).toBeLessThan(vertexCount);
    const materials = new Set<number>();
    for (let i = 6; i < mesh.vertices.length; i += 7) materials.add(mesh.vertices[i]!);
    expect([...materials].sort()).toEqual([MAT_FRAME, MAT_FRONT, MAT_BACK, MAT_BUTTON].sort());
  });

  test("normals are unit length", () => {
    const mesh = buildDeviceMesh(device3DModel(null, { width: 1206, height: 2622 }, "phone"));
    for (let i = 0; i < mesh.vertices.length; i += 7 * 37) {
      const n = Math.hypot(mesh.vertices[i + 3]!, mesh.vertices[i + 4]!, mesh.vertices[i + 5]!);
      expect(n).toBeCloseTo(1, 4);
    }
  });
});
