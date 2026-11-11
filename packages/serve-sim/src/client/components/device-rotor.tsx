import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  DEVICE_ROTATION_DURATION_MS,
  DEVICE_ROTATION_EASING,
  deviceRotationStart,
  isSidewaysRotation,
  rotationFromMatrix,
} from "../utils/device-rotation";

// See utils/device-rotation.ts for the model. Two pieces:
//
//   <DeviceRotor degrees>          fills the (rest-orientation) container with
//                                  the device in its natural portrait box,
//                                  turned by `degrees`; animates on change.
//     …bezel…
//     <DeviceRotorScreen degrees>  counter-rotates the screen content back to
//                                  display space, so at rest the stream and
//                                  input layer are axis-aligned (taps map 1:1).
//
// Both size themselves with container-query units against a size container,
// so the rotor tracks the container through resizes without measuring.

const fill: CSSProperties = { position: "absolute", inset: 0, containerType: "size" };

function turnedBoxStyle(degrees: number): CSSProperties {
  const sideways = isSidewaysRotation(degrees);
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: sideways ? "100cqh" : "100cqw",
    height: sideways ? "100cqw" : "100cqh",
    transform: rotorTransform(degrees),
    transformOrigin: "center center",
  };
}

function rotorTransform(degrees: number, scale = 1): string {
  return `translate(-50%, -50%) rotate(${degrees}deg) scale(${scale})`;
}

export function DeviceRotor({
  degrees,
  reducedMotion,
  children,
}: {
  /** Clockwise page rotation of the device (0, 90, 180, -90). */
  degrees: number;
  /** Snap instead of spinning. */
  reducedMotion: boolean;
  children: ReactNode;
}) {
  const rotorRef = useRef<HTMLDivElement | null>(null);
  const lastRef = useRef<{ degrees: number; length: number } | null>(null);

  // FLIP: React has already laid the rotor out for the new orientation; start
  // it at the pose (and on-screen size) the viewer last saw and animate to
  // rest. Runs before paint, so the new layout never flashes un-animated.
  useLayoutEffect(() => {
    const el = rotorRef.current;
    if (!el) return;
    const toLength = el.offsetHeight;
    const prev = lastRef.current;
    lastRef.current = { degrees, length: toLength };
    if (!prev || prev.degrees === degrees) return;

    const running = typeof el.getAnimations === "function" ? el.getAnimations() : [];
    let fromDegrees = prev.degrees;
    let fromScale = 1;
    if (running.length > 0) {
      // Interrupted mid-spin: continue from where it visibly is.
      const transform = getComputedStyle(el).transform;
      if (transform && transform !== "none" && typeof DOMMatrixReadOnly !== "undefined") {
        const current = rotationFromMatrix(new DOMMatrixReadOnly(transform));
        fromDegrees = current.degrees;
        fromScale = current.scale;
      }
      for (const animation of running) animation.cancel();
    }
    delete el.dataset.rotating;
    if (reducedMotion || typeof el.animate !== "function") return;

    const start = deviceRotationStart({
      fromDegrees,
      toDegrees: degrees,
      fromScale,
      fromLength: prev.length,
      toLength,
    });
    el.dataset.rotating = "true";
    const animation = el.animate(
      [
        { transform: rotorTransform(start.degrees, start.scale) },
        { transform: rotorTransform(degrees) },
      ],
      { duration: DEVICE_ROTATION_DURATION_MS, easing: DEVICE_ROTATION_EASING },
    );
    animation.onfinish = () => {
      if (rotorRef.current === el && el.getAnimations().length === 0) delete el.dataset.rotating;
    };
  }, [degrees, reducedMotion]);

  return (
    <div style={fill}>
      <div ref={rotorRef} data-device-rotation={degrees} style={turnedBoxStyle(degrees)}>
        {children}
      </div>
    </div>
  );
}

/** Undo the rotor's turn for screen content (stream, input layer, overlays). */
export function DeviceRotorScreen({
  degrees,
  children,
}: {
  degrees: number;
  children: ReactNode;
}) {
  // The screen box is the rotor's screen slot turned back: swap its sides when
  // sideways, then rotate by -degrees. At rest the net transform is identity.
  return (
    <div style={fill}>
      <div data-device-screen="" style={turnedBoxStyle(-degrees)}>
        {children}
      </div>
    </div>
  );
}

/** True from the render where `degrees` changes until the spin has finished.
 *  Lets layout transitions (width / aspect-ratio tweens) step aside so the
 *  container snaps to its new size while the rotor carries the motion. */
export function useDeviceRotationInFlight(degrees: number): boolean {
  const [state, setState] = useState({ degrees, inFlight: false });
  if (state.degrees !== degrees) {
    setState({ degrees, inFlight: true });
  }
  useEffect(() => {
    if (!state.inFlight) return;
    const timer = setTimeout(
      () => setState((s) => (s.inFlight ? { ...s, inFlight: false } : s)),
      DEVICE_ROTATION_DURATION_MS,
    );
    return () => clearTimeout(timer);
  }, [state]);
  return state.inFlight || state.degrees !== degrees;
}
