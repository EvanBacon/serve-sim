import type { DeviceType } from "../simulator";

const SCREEN_ON_FILL = "#47b7ff";

// Compact device-family glyphs for the sidebar rows. Stroked outlines keyed off
// `getDeviceType(name)` — a stand-in when a device has no live stream thumbnail.
// Duo uses the custom cover-display silhouette.
export function DeviceGlyph({
  type,
  size = 20,
  screenOn = false,
  duo = false,
}: {
  type: DeviceType;
  size?: number;
  screenOn?: boolean;
  /** True for iPhone Duo / multi-display foldables. */
  duo?: boolean;
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

  if (duo) {
    return (
      <svg width={size} height={size} viewBox="0 0 102 102" fill="currentColor" data-testid="device-glyph-duo">
        {screenOn && (
          <path
            d="M24 10H70C75.5229 10 80 14.4772 80 20V83C80 88.5228 75.5228 93 70 93H24C22.8954 93 22 92.1046 22 91V12C22 10.8954 22.8954 10 24 10Z"
            fill={SCREEN_ON_FILL}
            data-testid="device-glyph-screen-on"
          />
        )}
        <path d="M17 91V12C17 8.13401 20.134 5 24 5H70C78.2843 5 85 11.7157 85 20V83L84.9951 83.3867C84.7932 91.3638 78.3638 97.7932 70.3867 97.9951L70 98V93C75.5228 93 80 88.5228 80 83V20C80 14.4772 75.5229 10 70 10H24C22.8954 10 22 10.8954 22 12V91C22 92.1046 22.8954 93 24 93V98L23.6396 97.9912C20.0605 97.8097 17.1903 94.9395 17.0088 91.3604L17 91ZM70 93V98H24V93H70Z" />
        <circle cx="69" cy="21" r="4" />
        <path d="M40 88.5C40 87.6716 40.6716 87 41.5 87H61.5C62.3284 87 63 87.6716 63 88.5C63 89.3284 62.3284 90 61.5 90H41.5C40.6716 90 40 89.3284 40 88.5Z" />
      </svg>
    );
  }

  switch (type) {
    case "ipad":
      return (
        <svg {...common}>
          {screenOn && (
            <rect
              x="5"
              y="3"
              width="15"
              height="19"
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
              x="6"
              y="3"
              width="11"
              height="19"
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
