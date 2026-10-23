import { describe, expect, test } from "bun:test";
import {
  cameraEye,
  fitDistance,
  panTarget,
  pickPlane,
  pointInConvexQuad,
  projectToScreen,
  viewProjection,
  type OrbitCamera,
} from "../client/hierarchy-3d/projection";

const front: OrbitCamera = { yaw: 0, pitch: 0, distance: 1000, target: [0, 0, 0] };

describe("orbit camera", () => {
  test("yaw/pitch 0 looks straight down -z from +z", () => {
    const [x, y, z] = cameraEye(front);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1000);
  });

  test("positive yaw swings the eye to +x, positive pitch raises it", () => {
    expect(cameraEye({ ...front, yaw: 90 })[0]).toBeCloseTo(1000);
    expect(cameraEye({ ...front, pitch: 90 })[1]).toBeCloseTo(1000);
  });

  test("the target projects to the viewport center", () => {
    const m = viewProjection({ ...front, yaw: 33, pitch: -12, target: [10, 20, 30] }, 1.5);
    const p = projectToScreen(m, [10, 20, 30], 300, 200)!;
    expect(p.x).toBeCloseTo(150);
    expect(p.y).toBeCloseTo(100);
  });

  test("+y in world is up on screen", () => {
    const m = viewProjection(front, 1);
    expect(projectToScreen(m, [0, 100, 0], 200, 200)!.y).toBeLessThan(100);
  });

  test("fitDistance makes a plane fill the viewport within the margin", () => {
    const d = fitDistance(400, 800, 1, 35, 1);
    const m = viewProjection({ ...front, distance: d }, 1);
    const top = projectToScreen(m, [0, 400, 0], 500, 500)!;
    expect(top.y).toBeCloseTo(0, 3);
  });

  test("panning right moves the target left in world x when looking head-on", () => {
    const t = panTarget(front, 100, 0, 500);
    expect(t[0]).toBeLessThan(0);
    expect(t[1]).toBeCloseTo(0);
    expect(t[2]).toBeCloseTo(0);
  });

  test("points behind the camera don't project", () => {
    expect(projectToScreen(viewProjection(front, 1), [0, 0, 2000], 100, 100)).toBeNull();
  });
});

describe("pointInConvexQuad", () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  test("inside / outside, both windings", () => {
    expect(pointInConvexQuad(5, 5, square)).toBe(true);
    expect(pointInConvexQuad(15, 5, square)).toBe(false);
    expect(pointInConvexQuad(5, 5, [...square].reverse())).toBe(true);
  });
  test("degenerate quads never hit", () => {
    expect(pointInConvexQuad(0, 0, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }])).toBe(false);
  });
});

describe("pickPlane", () => {
  const m = viewProjection(front, 1);
  test("picks the plane nearest the camera under the pointer", () => {
    const planes = [
      { x0: -100, y0: -100, x1: 100, y1: 100, z: 0 },
      { x0: -50, y0: -50, x1: 50, y1: 50, z: 40 },
      null,
      { x0: 200, y0: 200, x1: 300, y1: 300, z: 80 },
    ];
    expect(pickPlane(m, 1000, planes, 250, 250, 500, 500)).toBe(1);
    expect(pickPlane(m, 1000, planes, 200, 250, 500, 500)).toBe(0);
    expect(pickPlane(m, 1000, planes, 5, 5, 500, 500)).toBe(-1);
  });

  test("from behind, the deepest plane is nearest", () => {
    const back = viewProjection({ ...front, yaw: 180 }, 1);
    const planes = [
      { x0: -100, y0: -100, x1: 100, y1: 100, z: 0 },
      { x0: -50, y0: -50, x1: 50, y1: 50, z: 40 },
    ];
    expect(pickPlane(back, -1000, planes, 250, 250, 500, 500)).toBe(0);
  });

  test("a small plane in front wins over a big plane behind it, even off-center at an angle", () => {
    // Regression: ranking by each plane's centre depth picked the big window
    // behind a small view near its edge when viewed at the default angle.
    const cam: OrbitCamera = { yaw: -32, pitch: 14, distance: 1500, target: [0, 0, 0] };
    const vp = viewProjection(cam, 1);
    const eyeZ = cameraEye(cam)[2];
    const small = { x0: -200, y0: 300, x1: -150, y1: 340, z: 30 };
    const planes = [{ x0: -201, y0: -437, x1: 201, y1: 437, z: 0 }, small];
    const hit = projectToScreen(vp, [-175, 320, 30], 800, 800)!;
    expect(pickPlane(vp, eyeZ, planes, hit.x, hit.y, 800, 800)).toBe(1);
  });

  test("equal depth goes to the later (top-drawn) plane", () => {
    const planes = [
      { x0: -100, y0: -100, x1: 100, y1: 100, z: 0 },
      { x0: -100, y0: -100, x1: 100, y1: 100, z: 0 },
    ];
    expect(pickPlane(m, 1000, planes, 250, 250, 500, 500)).toBe(1);
  });
});
