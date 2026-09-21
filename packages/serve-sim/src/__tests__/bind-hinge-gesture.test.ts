import { expect, test } from "bun:test";
import { bindHingeGesture } from "../client/utils/bind-hinge-gesture";

class Surface extends EventTarget {
  clientWidth = 400;
  clientHeight = 600;
  captured = new Set<number>();
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) { this.captured.delete(id); }
}
function dispatch(surface: Surface, type: string, properties: Record<string, unknown>) {
  const event = Object.assign(new Event(type, { cancelable: true }), { button: 0, pointerType: "touch", ...properties });
  surface.dispatchEvent(event);
  return event;
}

test("two finger pinch opens from closed and closes from flat without app input", () => {
  const surface = new Surface();
  let angle = 0;
  const cleanup = bindHingeGesture(surface as unknown as HTMLElement, () => ({ angle, onChange: (next) => { angle = next; } }));
  dispatch(surface, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
  dispatch(surface, "pointerdown", { pointerId: 2, clientX: 200, clientY: 100 });
  const move = dispatch(surface, "pointermove", { pointerId: 2, clientX: 300, clientY: 100 });
  expect(move.defaultPrevented).toBe(true);
  expect(angle).toBe(180);
  dispatch(surface, "pointerup", { pointerId: 2 });
  dispatch(surface, "pointerup", { pointerId: 1 });
  dispatch(surface, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
  dispatch(surface, "pointerdown", { pointerId: 2, clientX: 300, clientY: 100 });
  dispatch(surface, "pointermove", { pointerId: 2, clientX: 200, clientY: 100 });
  expect(angle).toBe(0);
  cleanup();
  expect(surface.captured.size).toBe(0);
  expect(dispatch(surface, "wheel", { deltaY: -180, deltaMode: 0 }).defaultPrevented).toBe(false);
  expect(angle).toBe(0);
});

test("trackpad wheel and Safari pinch both clamp and prevent browser zoom", () => {
  const surface = new Surface();
  let angle = 0;
  const cleanup = bindHingeGesture(surface as unknown as HTMLElement, () => ({ angle, onChange: (next) => { angle = next; } }));
  expect(dispatch(surface, "wheel", { ctrlKey: true, deltaY: -180, deltaMode: 0 }).defaultPrevented).toBe(true);
  expect(angle).toBe(180);
  dispatch(surface, "gesturestart", { scale: 1 });
  dispatch(surface, "gesturechange", { scale: 0.5 });
  expect(angle).toBe(0);
  dispatch(surface, "wheel", { deltaY: -180, deltaMode: 0 });
  expect(angle).toBe(0);
  dispatch(surface, "gestureend", { scale: 0.5 });
  cleanup();
});

test("mouse folding keeps its scale when the active panel changes size", () => {
  const surface = new Surface();
  let angle = 0;
  const cleanup = bindHingeGesture(surface as unknown as HTMLElement, () => ({ angle, onChange: (next) => { angle = next; } }));
  dispatch(surface, "pointerdown", { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 0 });
  surface.clientWidth = 800;
  dispatch(surface, "pointermove", { pointerId: 1, pointerType: "mouse", clientX: 400, clientY: 0 });
  expect(angle).toBe(180);
  cleanup();
});
