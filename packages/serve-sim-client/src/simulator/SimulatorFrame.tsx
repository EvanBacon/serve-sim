import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { StreamConfig } from "../types.js";
import {
  DeviceFrameChrome,
  fallbackScreenSize,
  getDeviceType,
  screenBorderRadius,
  simulatorAspectRatio,
  simulatorMaxWidth,
} from "./deviceFrames.js";
import { isLandscapeConfig } from "./orientation.js";
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
  onScreenConfigChange,
  ...streamProps
}: SimulatorFrameProps) {
  const deviceType = getDeviceType(deviceName);
  const [liveScreenConfig, setLiveScreenConfig] = useState<StreamConfig | null>(null);
  const fallbackScreen = fallbackScreenSize(deviceType, deviceName);
  const streamConfig = streamProps.stream?.config ?? null;
  const activeScreen = liveScreenConfig ?? streamConfig ?? fallbackScreen;
  const isLandscape = isLandscapeConfig(activeScreen);
  const isRotatedLandscape = isLandscape && fallbackScreen.width < fallbackScreen.height;
  const shouldShowChrome = showChrome && !bare && !isRotatedLandscape;

  useEffect(() => {
    setLiveScreenConfig(null);
  }, [deviceName, streamProps.device, streamProps.stream]);

  useEffect(() => {
    if (!streamConfig) return;
    setLiveScreenConfig((prev) =>
      prev &&
      prev.width === streamConfig.width &&
      prev.height === streamConfig.height &&
      prev.orientation === streamConfig.orientation
        ? prev
        : streamConfig,
    );
  }, [streamConfig, streamConfig?.width, streamConfig?.height, streamConfig?.orientation]);

  const handleScreenConfigChange = useCallback((config: StreamConfig) => {
    setLiveScreenConfig((prev) =>
      prev &&
      prev.width === config.width &&
      prev.height === config.height &&
      prev.orientation === config.orientation
        ? prev
        : config,
    );
    onScreenConfigChange?.(config);
  }, [onScreenConfigChange]);

  const aspectRatio = simulatorAspectRatio(activeScreen, fallbackScreen);
  const imgBorderRadius = bare ? 44 : screenBorderRadius(deviceType, activeScreen);
  const maxWidth = simulatorMaxWidth(deviceType, activeScreen);

  return (
    <div
      data-simulator-frame
      data-device-type={deviceType}
      data-orientation={isLandscape ? "landscape" : "portrait"}
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
        onScreenConfigChange={handleScreenConfigChange}
      />
      {shouldShowChrome && (
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
