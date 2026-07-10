import { describe, expect, it } from "bun:test";
import { parseGestureSteps, stepPayload, DEFAULT_STEP_DELAY_MS } from "../gesture-steps";

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

describe("DEFAULT_STEP_DELAY_MS", () => {
  it("is about one 60fps frame", () => {
    expect(DEFAULT_STEP_DELAY_MS).toBe(16);
  });
});
