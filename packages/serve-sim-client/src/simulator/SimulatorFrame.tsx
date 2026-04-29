import type { CSSProperties, ReactNode } from "react";
import {
  DEVICE_FRAMES,
  DeviceFrameChrome,
  SIMULATOR_SCREENS,
  getDeviceType,
  screenBorderRadius,
  type DeviceType,
} from "./deviceFrames.js";
import { SimulatorStream, type SimulatorStreamProps } from "./SimulatorStream.js";

export interface SimulatorFrameProps
  extends Omit<SimulatorStreamProps, "style" | "imageStyle" | "headerless"> {
  /** Device name (e.g. "iPhone 17 Pro Max"). Drives aspect ratio, chrome, and max-width. */
  deviceName?: string | null;
  /** Show the frame chrome (bezels, dynamic island, crown, etc.). Default: true. */
  showChrome?: boolean;
  /** Render the stream edge-to-edge without device chrome (e.g. mobile fullscreen). */
  bare?: boolean;
  /** Extra overlay content rendered inside the container (e.g. error toast, drop zone). */
  children?: ReactNode;
  /** Container className for layout (width, margin, etc.). */
  className?: string;
  /** Extra container styles. */
  style?: CSSProperties;
}

/** Default per-device-type max-widths, in px. */
const DEFAULT_MAX_WIDTHS: Record<DeviceType, number> = {
  iphone: 320,
  ipad: 400,
  watch: 200,
  vision: 580,
};

/**
 * Self-contained simulator UI: renders the device frame chrome and the
 * streaming view sized to match the real simulator screen. The caller only
 * passes the device name — aspect ratio, border radius, and bezels are
 * derived automatically.
 */
export function SimulatorFrame({
  deviceName,
  showChrome = false,
  bare = false,
  children,
  className,
  style,
  ...streamProps
}: SimulatorFrameProps) {
  const deviceType = getDeviceType(deviceName);
  const frame = DEVICE_FRAMES[deviceType];
  const screen = deviceName ? SIMULATOR_SCREENS[deviceName] : null;

  // Aspect ratio: prefer exact simulator pixel dimensions, fall back to the
  // frame's screen area (bezel-inset) so the stream always matches its frame.
  const aspectRatio = bare
    ? `${frame.width} / ${frame.height}`
    : screen
      ? `${screen.width} / ${screen.height}`
      : `${frame.width - 2 * frame.bezelX} / ${frame.height - 2 * frame.bezelY}`;

  const imgBorderRadius = bare ? 44 : screenBorderRadius(deviceType);
  const maxWidth = DEFAULT_MAX_WIDTHS[deviceType];

  return (
    <div
      data-simulator-frame
      data-device-type={deviceType}
      className={className}
      style={{
        position: "relative",
        background: "black",
        width: "100%",
        maxWidth,
        aspectRatio,
        ...style,
      }}
    >
      <SimulatorStream
        {...streamProps}
        headerless
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          border: "none",
        }}
        imageStyle={{
          borderRadius: imgBorderRadius,
          cornerShape: "superellipse(1.3)",
        } as CSSProperties}
      />
      {showChrome && !bare && (
        <div
          style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 10 }}
        >
          <DeviceFrameChrome type={deviceType} />
        </div>
      )}
      {children}
    </div>
  );
}
