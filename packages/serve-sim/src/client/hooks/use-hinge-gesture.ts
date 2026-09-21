import { useEffect, useRef, type RefObject } from "react";
import { bindHingeGesture } from "../utils/bind-hinge-gesture";

/** Fold mode owns input, so a hinge pinch never also pinches the app underneath. */
export function useHingeGesture(target: RefObject<HTMLDivElement | null>, enabled: boolean, angle: number, onChange: (angle: number) => void) {
  const current = useRef({ angle, onChange });
  current.current = { angle, onChange };
  useEffect(() => {
    const element = target.current;
    if (!enabled || !element) return;
    return bindHingeGesture(element, () => current.current);
  }, [target, enabled]);
}
