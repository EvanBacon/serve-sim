import { clampHingeAngle, hingeAngleForPinch, hingeAngleForWheel } from "./hinge-gesture";

/** Capture folding gestures before they reach the simulator input surface. */
export function bindHingeGesture(element: HTMLElement, current: () => { angle: number; onChange: (angle: number) => void }): () => void {
    let degrees = current().angle;
    let startAngle = degrees, startDistance = 0, mouseX = 0, mouseWidth = 1;
    let safariGesture = false;
    let lastWheel = 0;
    const points = new Map<number, { x: number; y: number }>();
    const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const distance = () => {
      const [a, b] = [...points.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const emit = (value: number) => {
      degrees = Math.round(clampHingeAngle(value) * 10) / 10;
      current().onChange(degrees);
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      stop(event);
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      element.setPointerCapture(event.pointerId);
      startAngle = current().angle;
      degrees = startAngle;
      startDistance = distance();
      mouseX = event.clientX;
      mouseWidth = Math.max(1, element.clientWidth);
    };
    const move = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) return;
      stop(event);
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (points.size === 2 && startDistance > 0) emit(hingeAngleForPinch(startAngle, distance() / startDistance));
      else if (event.pointerType === "mouse") emit(startAngle + 180 * (event.clientX - mouseX) / mouseWidth);
    };
    const up = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) return;
      stop(event);
      points.delete(event.pointerId);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      startAngle = degrees;
      startDistance = distance();
    };
    const wheel = (event: WheelEvent) => {
      stop(event);
      if (safariGesture) return;
      if (Date.now() - lastWheel > 200) degrees = current().angle;
      lastWheel = Date.now();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      emit(hingeAngleForWheel(degrees, event.deltaY * multiplier));
    };
    const gesture = (event: Event) => {
      stop(event);
      if (event.type === "gesturestart") { safariGesture = true; startAngle = current().angle; }
      if (event.type === "gesturechange") emit(hingeAngleForPinch(startAngle, (event as Event & { scale: number }).scale));
      if (event.type === "gestureend") safariGesture = false;
    };
    const block = (event: Event) => stop(event);
    const bindings: Array<[string, EventListener]> = [
      ["pointerdown", down as EventListener], ["pointermove", move as EventListener],
      ["pointerup", up as EventListener], ["pointercancel", up as EventListener],
      ["wheel", wheel as EventListener], ["gesturestart", gesture], ["gesturechange", gesture], ["gestureend", gesture],
      ["mousedown", block], ["mousemove", block], ["mouseup", block], ["click", block],
      ["touchstart", block], ["touchmove", block], ["touchend", block],
    ];
    for (const [name, fn] of bindings) element.addEventListener(name, fn, { capture: true, passive: false });
    return () => {
      for (const [name, fn] of bindings) element.removeEventListener(name, fn, true);
      for (const id of points.keys()) if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    };
}
