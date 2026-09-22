import { expect, test } from "bun:test";
import { duoHardwarePositions, duoPoseKey } from "../client/utils/duo-controls-position";
import type { DuoProjection } from "../duo-renderer";

const pose: DuoProjection = { width: 1000, height: 900, panel: "inner", hingeDegrees: 130,
  pieces: [[], [[0.9, 0.2], [0.9, 0.8], [0.5, 0.8], [0.5, 0.2], [0, 0, 1, 0.5]]] };

test("hardware anchors follow the physical top and right edges", () => {
  const [down, up, power, camera] = duoHardwarePositions(pose);
  expect(down!.y).toBe(0.2);
  expect(up!.x).toBeGreaterThan(down!.x);
  expect(power!.x).toBe(0.9);
  expect(camera!.y).toBeGreaterThan(power!.y);
  expect(power!.angle).toBe(90);
});

test("every hardware anchor and outward direction follows all four rotations", () => {
  const base = duoHardwarePositions(pose);
  for (const degrees of [0, 90, 180, 270]) {
    const r = degrees * Math.PI / 180;
    const rotate = ([x, y]: number[]) => {
      const px = (x! - 0.5) * pose.width, py = (y! - 0.5) * pose.height;
      return [0.5 + (px * Math.cos(r) - py * Math.sin(r)) / pose.width,
        0.5 + (px * Math.sin(r) + py * Math.cos(r)) / pose.height];
    };
    const rotated = duoHardwarePositions({ ...pose, pieces: pose.pieces.map((piece) => piece.map((p, i) => i < 4 ? rotate(p) : p)) });
    rotated.forEach((anchor, i) => {
      const expected = rotate([base[i]!.x, base[i]!.y]);
      expect(anchor.x).toBeCloseTo(expected[0]!, 6);
      expect(anchor.y).toBeCloseTo(expected[1]!, 6);
      expect(Math.cos(anchor.angle * Math.PI / 180)).toBeCloseTo(Math.cos((base[i]!.angle + degrees) * Math.PI / 180), 6);
    });
  }
});

test("cover anchors use cover corner order", () => {
  const cover = { ...pose, panel: "cover" as const, pieces: [[[0.5, 0.2], [0.9, 0.2], [0.9, 0.8], [0.5, 0.8]]] };
  expect(duoHardwarePositions(cover)).toEqual(duoHardwarePositions(pose));
});

test("missing geometry hides controls and resolution changes do not imply motion", () => {
  expect(duoHardwarePositions(null)).toEqual([]);
  expect(duoHardwarePositions({ ...pose, pieces: [] })).toEqual([]);
  expect(duoPoseKey(pose)).toBe(duoPoseKey({ ...pose, width: 3000, height: 2700 }));
  expect(duoPoseKey(pose)).not.toBe(duoPoseKey({ ...pose, hingeDegrees: 131 }));
});
