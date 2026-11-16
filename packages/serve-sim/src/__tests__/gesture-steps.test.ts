import { describe, expect, it } from "bun:test";
import { HID_EDGE_BOTTOM, HID_EDGE_LEFT } from "../client/simulator/orientation";
import {
  DEFAULT_STEP_DELAY_MS,
  MULTI_TOUCH_TAG,
  TOUCH_TAG,
  gestureStepFrames,
  parseGestureSteps,
  stepPayload,
} from "../gesture-steps";

describe("parseGestureSteps", () => {
  it("accepts a single touch object (back-compat with the one-event form)", () => {
    expect(parseGestureSteps('{"type":"begin","x":0.5,"y":0.5}')).toEqual([
      { type: "begin", x: 0.5, y: 0.5 },
    ]);
  });

  it("accepts an array of steps in order (the drag/scroll form)", () => {
    const steps = parseGestureSteps(
      '[{"type":"begin","x":0.5,"y":0.8},{"type":"move","x":0.5,"y":0.4},{"type":"end","x":0.5,"y":0.4}]',
    );
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.type)).toEqual(["begin", "move", "end"]);
  });

  it("preserves the multi-touch shape (x1/y1/x2/y2)", () => {
    expect(parseGestureSteps('{"type":"begin","x1":0.4,"y1":0.5,"x2":0.6,"y2":0.5}')).toEqual([
      { type: "begin", x1: 0.4, y1: 0.5, x2: 0.6, y2: 0.5 },
    ]);
  });

  it("preserves edge and per-step delayMs", () => {
    const [step] = parseGestureSteps('{"type":"begin","x":0,"y":0.5,"edge":1,"delayMs":80}');
    expect(step).toEqual({ type: "begin", x: 0, y: 0.5, edge: 1, delayMs: 80 });
  });

  it("rejects invalid JSON with the original argument in the message", () => {
    expect(() => parseGestureSteps("not json")).toThrow("Invalid JSON: not json");
  });

  it("rejects an empty array", () => {
    expect(() => parseGestureSteps("[]")).toThrow("at least one touch step");
  });

  it("rejects a step with an unknown type, naming the failing step", () => {
    expect(() =>
      parseGestureSteps('[{"type":"begin","x":0.5,"y":0.5},{"type":"tap","x":0.5,"y":0.5}]'),
    ).toThrow('step 2/2: "type" must be one of begin|move|end');
  });

  it("rejects a step with missing or out-of-range coords", () => {
    expect(() => parseGestureSteps('{"type":"begin","x":0.5}')).toThrow("normalized 0..1 coords");
    expect(() => parseGestureSteps('{"type":"begin","x":1.5,"y":0.5}')).toThrow(
      "normalized 0..1 coords",
    );
  });

  it("rejects a negative delayMs", () => {
    expect(() => parseGestureSteps('{"type":"begin","x":0.5,"y":0.5,"delayMs":-5}')).toThrow(
      '"delayMs" must be a non-negative number',
    );
  });

  it("rejects a step with both single-touch and multi-touch coords, naming the step", () => {
    expect(() =>
      parseGestureSteps(
        '[{"type":"begin","x":0.5,"y":0.5},{"type":"move","x":0.5,"y":0.5,"x1":0.4,"y1":0.5,"x2":0.6,"y2":0.5}]',
      ),
    ).toThrow("step 2/2: use either single-touch");
    // Even a partial multi-touch key alongside valid x/y is ambiguous.
    expect(() => parseGestureSteps('{"type":"begin","x":0.5,"y":0.5,"x2":0.6}')).toThrow("not both");
  });

  it("rejects edge on multi-touch and out-of-range edge values", () => {
    expect(() =>
      parseGestureSteps('{"type":"begin","x1":0.4,"y1":0.5,"x2":0.6,"y2":0.5,"edge":1}'),
    ).toThrow('"edge" is only supported on single-touch');
    expect(() => parseGestureSteps('{"type":"begin","x":0,"y":0.5,"edge":7}')).toThrow(
      '"edge" must be an integer 0..4',
    );
  });

  it("drops unknown fields so they never reach the wire", () => {
    expect(parseGestureSteps('{"type":"begin","x":0.5,"y":0.5,"ack":99,"foo":1}')).toEqual([
      { type: "begin", x: 0.5, y: 0.5 },
    ]);
  });

  it("rejects non-object steps", () => {
    expect(() => parseGestureSteps('[{"type":"begin","x":0.5,"y":0.5},42]')).toThrow(
      "step 2/2: expected an object",
    );
  });
});

describe("stepPayload", () => {
  it("strips the CLI-only delayMs before the wire payload", () => {
    const payloads = parseGestureSteps('{"type":"move","x":0.5,"y":0.3,"delayMs":80}').map(stepPayload);
    expect(payloads).toEqual([{ type: "move", x: 0.5, y: 0.3 }]);
  });
});

describe("gestureStepFrames", () => {
  it("sends a single object as one immediate 0x03 frame (unchanged behaviour)", () => {
    expect(gestureStepFrames(parseGestureSteps('{"type":"begin","x":0.3,"y":0.7}'), undefined)).toEqual([
      { tag: TOUCH_TAG, payload: { type: "begin", x: 0.3, y: 0.7 }, delayMs: 0 },
    ]);
  });

  it("uses each step's delayMs as the wait before the next frame, default 16ms", () => {
    const frames = gestureStepFrames(
      parseGestureSteps(
        '[{"type":"begin","x":0.5,"y":0.8},{"type":"move","x":0.5,"y":0.3,"delayMs":80},{"type":"end","x":0.5,"y":0.3,"delayMs":500}]',
      ),
      undefined,
    );
    expect(frames.map((f) => f.delayMs)).toEqual([0, DEFAULT_STEP_DELAY_MS, 80]);
    for (const frame of frames) expect(frame.payload).not.toHaveProperty("delayMs");
  });

  it("routes multi-touch to 0x05 and remaps both fingers for the orientation", () => {
    const [frame] = gestureStepFrames(
      parseGestureSteps('{"type":"begin","x1":0.2,"y1":0.4,"x2":0.8,"y2":0.6}'),
      "landscape_left",
    );
    expect(frame!.tag).toBe(MULTI_TOUCH_TAG);
    // landscape_left: raw = { x: y, y: 1 - x }
    const p = frame!.payload as unknown as Record<string, number>;
    expect(p.x1).toBeCloseTo(0.4);
    expect(p.y1).toBeCloseTo(0.8);
    expect(p.x2).toBeCloseTo(0.6);
    expect(p.y2).toBeCloseTo(0.2);
    expect(p).not.toHaveProperty("x");
  });

  it("remaps single-touch points and edges for the orientation", () => {
    const [frame] = gestureStepFrames(
      parseGestureSteps(`{"type":"begin","x":0.01,"y":0.5,"edge":${HID_EDGE_LEFT}}`),
      "landscape_left",
    );
    expect(frame!.tag).toBe(TOUCH_TAG);
    expect(frame!.payload).toMatchObject({ type: "begin", edge: HID_EDGE_BOTTOM });
    const p = frame!.payload as unknown as Record<string, number>;
    expect(p.x).toBeCloseTo(0.5);
    expect(p.y).toBeCloseTo(0.99);
  });

  it("leaves coords untouched in portrait", () => {
    const steps = parseGestureSteps('[{"type":"begin","x1":0.2,"y1":0.4,"x2":0.8,"y2":0.6},{"type":"end","x":0.1,"y":0.9,"edge":3}]');
    expect(gestureStepFrames(steps, "portrait").map((f) => f.payload)).toEqual(steps.map(stepPayload));
  });
});

describe("DEFAULT_STEP_DELAY_MS", () => {
  it("is about one 60fps frame", () => {
    expect(DEFAULT_STEP_DELAY_MS).toBe(16);
  });
});
