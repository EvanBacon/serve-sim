import { describe, expect, test } from "bun:test";
import { resistedGrabberOffset } from "../client/components/resize-handle";

describe("resize handle grabber motion", () => {
  test("starts centered", () => {
    expect(resistedGrabberOffset({ clientY: 200, top: 0, height: 400 })).toBe(0);
  });

  test("follows nearby pointer movement with resistance", () => {
    const offset = resistedGrabberOffset({ clientY: 240, top: 0, height: 400 });

    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(40);
  });

  test("compresses farther movement away from the middle", () => {
    const near = resistedGrabberOffset({ clientY: 240, top: 0, height: 400 });
    const far = resistedGrabberOffset({ clientY: 380, top: 0, height: 400 });

    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThan(180);
  });
});
