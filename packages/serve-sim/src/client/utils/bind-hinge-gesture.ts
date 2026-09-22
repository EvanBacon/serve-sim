import { clampHingeAngle, hingeAngleForPinch, hingeAngleForWheel } from "./hinge-gesture";

/** Fold via pinch / Alt-drag / ctrl-wheel. Single-finger and plain scroll stay with the sim. */
export function bindHingeGesture(element: HTMLElement, current: () => { angle: number; onChange: (angle: number) => void }): () => void {
    let degrees = current().angle;
    let startAngle = degrees, startDistance = 0, mouseX = 0, mouseWidth = 1;
    let safariGesture = false;
    let lastWheel = 0;
    let folding = false;
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
    const beginFold = (event: PointerEvent) => {
      if (folding) return;
      folding = true;
      stop(event);
      for (const id of points.keys()) {
        if (!element.hasPointerCapture(id)) element.setPointerCapture(id);
      }
      startAngle = current().angle;
      degrees = startAngle;
      startDistance = distance();
      mouseX = event.clientX;
      mouseWidth = Math.max(1, element.clientWidth);
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (event.altKey || points.size >= 2) beginFold(event);
    };
    const move = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!folding) {
        if (event.altKey || points.size >= 2) beginFold(event);
        else return;
      }
      stop(event);
      if (points.size === 2 && startDistance > 0) emit(hingeAngleForPinch(startAngle, distance() / startDistance));
      else if (event.pointerType === "mouse" && event.altKey) emit(startAngle + 180 * (event.clientX - mouseX) / mouseWidth);
    };
    const up = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) return;
      if (folding) stop(event);
      points.delete(event.pointerId);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      if (points.size === 0) folding = false;
      startAngle = degrees;
      startDistance = distance();
    };
    const wheel = (event: WheelEvent) => {
      // Plain trackpad scroll must reach the sim; only pinch-zoom (ctrl) or Alt folds.
      if (!event.ctrlKey && !event.altKey) return;
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
    const bindings: Array<[string, EventListener]> = [
      ["pointerdown", down as EventListener], ["pointermove", move as EventListener],
      ["pointerup", up as EventListener], ["pointercancel", up as EventListener],
      ["wheel", wheel as EventListener], ["gesturestart", gesture], ["gesturechange", gesture], ["gestureend", gesture],
    ];
    for (const [name, fn] of bindings) element.addEventListener(name, fn, { capture: true, passive: false });
    return () => {
      for (const [name, fn] of bindings) element.removeEventListener(name, fn, true);
      for (const id of points.keys()) if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    };
}
