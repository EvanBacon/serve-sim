import type { DeviceType } from "serve-sim-client/simulator";

const SCREEN_ON_FILL = "#47b7ff";

// Compact device-family glyphs for the sidebar rows. Stroked outlines keyed off
// `getDeviceType(name)` — a stand-in when a device has no live stream thumbnail.
export function DeviceGlyph({
  type,
  size = 20,
  screenOn = false,
}: {
  type: DeviceType;
  size?: number;
  screenOn?: boolean;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (type) {
    case "ipad":
      return (
        <svg {...common}>
          {screenOn && (
            <rect
              x="5.05"
              y="3.55"
              width="13.9"
              height="16.45"
              rx="1.65"
              fill={SCREEN_ON_FILL}
              stroke="none"
              data-testid="device-glyph-screen-on"
            />
          )}
          <rect x="4" y="2.5" width="16" height="19" rx="2.5" />
          <line x1="12" y1="18.5" x2="12" y2="18.5" />
        </svg>
      );
    case "watch":
      return (
        <svg {...common}>
          <rect x="6.5" y="7" width="11" height="10" rx="3" />
          <path d="M8.5 7l.6-3.2A1.5 1.5 0 0 1 10.6 2.5h2.8a1.5 1.5 0 0 1 1.5 1.3L15.5 7" />
          <path d="M8.5 17l.6 3.2a1.5 1.5 0 0 0 1.5 1.3h2.8a1.5 1.5 0 0 0 1.5-1.3l.6-3.2" />
        </svg>
      );
    case "vision":
      return (
        <svg {...common}>
          <path d="M3 11a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v2.5a2.5 2.5 0 0 1-2.5 2.5c-1.8 0-2.5-1.2-3.5-1.8-.9-.5-1.6-.7-2.5-.7s-1.6.2-2.5.7c-1 .6-1.7 1.8-3.5 1.8A2.5 2.5 0 0 1 3 13.5z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          {screenOn && (
            <rect
              x="7.45"
              y="3.65"
              width="9.1"
              height="16.35"
              rx="2"
              fill={SCREEN_ON_FILL}
              stroke="none"
              data-testid="device-glyph-screen-on"
            />
          )}
          <rect x="6.5" y="2.5" width="11" height="19" rx="2.8" />
          <line x1="10.5" y1="5" x2="13.5" y2="5" />
        </svg>
      );
  }
}
