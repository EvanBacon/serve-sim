import { expect, test } from "bun:test";
import { duoHardwarePositions, duoPoseKey } from "../client/utils/duo-controls-position";
import type { DuoProjection } from "../duo-renderer";

const pose: DuoProjection = { width: 1000, height: 900, panel: "inner", hingeDegrees: 130,
  hardware: [{ x: 0.72, y: 0.18, angle: 0 }, { x: 0.8, y: 0.18, angle: 0 }, { x: 0.92, y: 0.42, angle: 90 }, { x: 0.92, y: 0.65, angle: 90 }],
  pieces: [[], [[0.9, 0.2], [0.9, 0.8], [0.5, 0.8], [0.5, 0.2], [0, 0, 1, 0.5]]] };

test("hardware anchors follow the physical top and right edges", () => {
  const [down, up, power, camera] = duoHardwarePositions(pose);
  expect(down!.y).toBe(0.18);
  expect(up!.x).toBeGreaterThan(down!.x);
  expect(power!.x).toBe(0.92);
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
    const rotated = duoHardwarePositions({ ...pose, hardware: pose.hardware!.map((point) => { const [x, y] = rotate([point.x, point.y]); return { x: x!, y: y!, angle: point.angle + degrees }; }), pieces: pose.pieces.map((piece) => piece.map((p, i) => i < 4 ? rotate(p) : p)) });
    rotated.forEach((anchor, i) => {
      const expected = rotate([base[i]!.x, base[i]!.y]);
      expect(anchor.x).toBeCloseTo(expected[0]!, 6);
      expect(anchor.y).toBeCloseTo(expected[1]!, 6);
      expect(Math.cos(anchor.angle * Math.PI / 180)).toBeCloseTo(Math.cos((base[i]!.angle + degrees) * Math.PI / 180), 6);
    });
  }
});

test("hardware centers are independent of the active screen panel", () => {
  const cover = { ...pose, panel: "cover" as const, pieces: [[[0.5, 0.2], [0.9, 0.2], [0.9, 0.8], [0.5, 0.8]]] };
  expect(duoHardwarePositions(cover)).toEqual(duoHardwarePositions(pose));
});

test("missing geometry hides controls and resolution changes do not imply motion", () => {
  expect(duoHardwarePositions(null)).toEqual([]);
  expect(duoHardwarePositions({ ...pose, hardware: undefined })).toEqual([]);
  expect(duoPoseKey(pose)).toBe(duoPoseKey({ ...pose, width: 3000, height: 2700 }));
  expect(duoPoseKey(pose)).not.toBe(duoPoseKey({ ...pose, hingeDegrees: 131 }));
});

test("uses projected button meshes rather than guessed screen-edge fractions", () => {
  const hardware = [
    { x: 0.73, y: 0.18, angle: 2 }, { x: 0.81, y: 0.182, angle: 2 },
    { x: 0.92, y: 0.41, angle: 91 }, { x: 0.918, y: 0.64, angle: 91 },
  ];
  expect(duoHardwarePositions({ ...pose, hardware })).toEqual(hardware.map((point, key) => ({ ...point, key })));
});
