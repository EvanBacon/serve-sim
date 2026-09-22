import { expect, test } from "bun:test";
import { duoAxFrame } from "../client/utils/duo-ax-frame";

test("inner AX frames use the active framebuffer rather than stale cover root bounds", () => {
  const settings = duoAxFrame({ x: 52, y: 417.333333333, width: 86.666666667, height: 68 }, { width: 2007, height: 2853 });
  expect(settings.x).toBeCloseTo(52 / 669);
  expect(settings.y).toBeCloseTo(417.333333333 / 951);
  expect(settings.width).toBeCloseTo(86.666666667 / 669);
  expect(settings.height).toBeCloseTo(68 / 951);
  // AX reports Safari near the raw top edge; the model maps it to the right.
  const safari = duoAxFrame({ x: 347.666666667, y: 15.833333333, width: 64, height: 64 }, { width: 2007, height: 2853 });
  expect(safari.x).toBeCloseTo(0.519681, 5);
  expect(safari.y).toBeCloseTo(0.016649, 5);
});

test("cover and inner full-screen AX rectangles normalize identically", () => {
  for (const [width, height] of [[1398, 2034], [2007, 2853]]) {
    expect(duoAxFrame({ x: 0, y: 0, width: width! / 3, height: height! / 3 }, { width: width!, height: height! })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  }
});
