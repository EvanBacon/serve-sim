import { describe, expect, test } from "bun:test";
import { device3DModel } from "../client/device-3d/model";
import {
  MAX_PITCH,
  MIN_PITCH,
  clampPitch,
  defaultView,
  identity,
  invert,
  multiply,
  nearestAngle,
  pickScreen,
  projectToNdc,
  rollForDeviceDegrees,
  sceneMatrices,
} from "../client/device-3d/scene";

const model = device3DModel(null, { width: 1206, height: 2622 }, "phone");

describe("scene math", () => {
  test("invert undoes multiply", () => {
    const scene = sceneMatrices(model, defaultView(), 1.4);
    const m = multiply(scene.projection, scene.view);
    const back = multiply(invert(m)!, m);
    const id = identity();
    for (let i = 0; i < 16; i++) expect(back[i]!).toBeCloseTo(id[i]!, 4);
  });

  test("pitch is clamped and angles tween the short way", () => {
    expect(clampPitch(10)).toBe(MAX_PITCH);
    expect(clampPitch(-10)).toBe(MIN_PITCH);
    expect(nearestAngle(0, (3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2, 9);
    expect(nearestAngle(Math.PI, -Math.PI + 0.1)).toBeCloseTo(Math.PI + 0.1, 9);
  });

  test("sim rotations roll the device the opposite way (CSS clockwise → GL ccw)", () => {
    expect(rollForDeviceDegrees(90)).toBeCloseTo(-Math.PI / 2, 9);
    expect(rollForDeviceDegrees(0)).toBe(-0);
  });

  test("the device fits the canvas in portrait and landscape", () => {
    for (const roll of [0, -Math.PI / 2]) {
      for (const aspect of [0.6, 1, 1.8]) {
        const scene = sceneMatrices(model, defaultView(roll), aspect);
        for (const x of [-1, 1]) {
          for (const y of [-1, 1]) {
            const p = projectToNdc(scene, [(x * model.width) / 2, (y * model.height) / 2, model.depth / 2]);
            expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
          }
        }
        expect(scene.groundY).toBeLessThan(scene.bottomY);
      }
    }
  });
});

describe("pickScreen", () => {
  test("hits what it projects, at any yaw / pitch / roll", () => {
    for (const view of [defaultView(), { yaw: 0.6, pitch: 0.5, roll: 0 }, defaultView(-Math.PI / 2)]) {
      const scene = sceneMatrices(model, view, 1.3);
      for (const [u, v] of [[0.5, 0.5], [0.2, 0.1], [0.85, 0.92]] as const) {
        const sc = model.screen;
        const p = [sc.x - sc.halfWidth + u * 2 * sc.halfWidth, sc.y + sc.halfHeight - v * 2 * sc.halfHeight, model.depth / 2];
        const ndc = projectToNdc(scene, p);
        const hit = pickScreen(model, scene, ndc.x, ndc.y)!;
        expect(hit.u).toBeCloseTo(u, 3);
        expect(hit.v).toBeCloseTo(v, 3);
        expect(hit.onScreen).toBe(true);
        expect(hit.onDevice).toBe(true);
      }
    }
  });

  test("off the device is neither screen nor device", () => {
    const scene = sceneMatrices(model, { yaw: 0, pitch: 0, roll: 0 }, 2);
    const hit = pickScreen(model, scene, 0.95, 0);
    expect(hit?.onScreen ?? false).toBe(false);
    expect(hit?.onDevice ?? false).toBe(false);
  });

  test("never taps through the back of the device", () => {
    const scene = sceneMatrices(model, { yaw: Math.PI, pitch: 0, roll: 0 }, 1);
    expect(pickScreen(model, scene, 0, 0)).toBeNull();
  });
});
