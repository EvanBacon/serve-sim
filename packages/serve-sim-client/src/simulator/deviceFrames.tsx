/**
 * Device frame chrome overlays — renders as SVG matching device dimensions.
 * Supports iPhone, iPad, and Apple Watch frames.
 */

export type DeviceType = "iphone" | "ipad" | "watch" | "vision";

export function getDeviceType(name?: string | null): DeviceType {
  if (!name) return "iphone";
  const lower = name.toLowerCase();
  if (lower.includes("ipad")) return "ipad";
  if (lower.includes("watch")) return "watch";
  if (lower.includes("vision")) return "vision";
  return "iphone";
}

/** Frame geometry for each device type. */
export const DEVICE_FRAMES = {
  iphone: { width: 427, height: 881, bezelX: 18, bezelY: 18, innerRadius: 55 },
  ipad: { width: 430, height: 605, bezelX: 16, bezelY: 16, innerRadius: 12 },
  watch: { width: 274, height: 322, bezelX: 12, bezelY: 12, innerRadius: 79 },
  vision: { width: 640, height: 400, bezelX: 12, bezelY: 12, innerRadius: 32 },
} as const;

// Legacy named exports for backwards compat
export const DEVICE_WIDTH = DEVICE_FRAMES.iphone.width;
export const DEVICE_HEIGHT = DEVICE_FRAMES.iphone.height;
export const DEVICE_BEZEL_X = DEVICE_FRAMES.iphone.bezelX;
export const DEVICE_BEZEL_Y = DEVICE_FRAMES.iphone.bezelY;
export const DEVICE_INNER_RADIUS = DEVICE_FRAMES.iphone.innerRadius;

/**
 * Known simulator screen dimensions (pixels from `xcrun simctl io <udid> enumerate`).
 * Used to set the correct video aspect ratio so the stream fills the frame perfectly.
 */
export const SIMULATOR_SCREENS: Record<string, { width: number; height: number }> = {
  // iPhone 17 series
  "iPhone 17 Pro Max": { width: 1320, height: 2868 },
  "iPhone 17 Pro": { width: 1206, height: 2622 },
  "iPhone 17": { width: 1206, height: 2622 },
  "iPhone Air": { width: 1260, height: 2736 },
  // iPhone 16 series
  "iPhone 16 Pro Max": { width: 1320, height: 2868 },
  "iPhone 16 Pro": { width: 1206, height: 2622 },
  "iPhone 16 Plus": { width: 1290, height: 2796 },
  "iPhone 16": { width: 1179, height: 2556 },
  "iPhone 16e": { width: 1170, height: 2532 },
  // iPhone 15 series
  "iPhone 15 Pro Max": { width: 1290, height: 2796 },
  "iPhone 15 Pro": { width: 1179, height: 2556 },
  "iPhone 15 Plus": { width: 1290, height: 2796 },
  "iPhone 15": { width: 1179, height: 2556 },
  // iPad
  "iPad Pro 13-inch (M5)": { width: 2064, height: 2752 },
  "iPad Pro 11-inch (M5)": { width: 1668, height: 2420 },
  "iPad Pro 13-inch (M4)": { width: 2064, height: 2752 },
  "iPad Pro 11-inch (M4)": { width: 1668, height: 2420 },
  "iPad Air 13-inch (M3)": { width: 2048, height: 2732 },
  "iPad Air 11-inch (M3)": { width: 1640, height: 2360 },
  "iPad (A16)": { width: 1640, height: 2360 },
  "iPad mini (A17 Pro)": { width: 1488, height: 2266 },
  // Apple Watch
  "Apple Watch Ultra 3 (49mm)": { width: 422, height: 514 },
  "Apple Watch Ultra 2 (49mm)": { width: 410, height: 502 },
  "Apple Watch Series 11 (46mm)": { width: 416, height: 496 },
  "Apple Watch Series 11 (42mm)": { width: 374, height: 446 },
  "Apple Watch Series 10 (46mm)": { width: 416, height: 496 },
  "Apple Watch Series 10 (42mm)": { width: 374, height: 446 },
  "Apple Watch SE 3 (44mm)": { width: 368, height: 448 },
  "Apple Watch SE 3 (40mm)": { width: 324, height: 394 },
  "Apple Watch SE (44mm)": { width: 368, height: 448 },
  "Apple Watch SE (40mm)": { width: 324, height: 394 },
  // Apple Vision Pro
  "Apple Vision Pro": { width: 1920, height: 1080 },
};

/** Returns the screen area inset as percentages of the frame, suitable for CSS positioning. */
export function screenInsets(type: DeviceType = "iphone") {
  const f = DEVICE_FRAMES[type];
  return {
    top: `${(f.bezelY / f.height) * 100}%`,
    left: `${(f.bezelX / f.width) * 100}%`,
    right: `${(f.bezelX / f.width) * 100}%`,
    bottom: `${(f.bezelY / f.height) * 100}%`,
  };
}

/** Border-radius for the screen clip area, scaled proportionally. */
export function screenBorderRadius(type: DeviceType = "iphone") {
  const f = DEVICE_FRAMES[type];
  const screenW = f.width - 2 * f.bezelX;
  const screenH = f.height - 2 * f.bezelY;
  return `${(f.innerRadius / screenW) * 100}% / ${(f.innerRadius / screenH) * 100}%`;
}

/** Renders the correct frame chrome for the given device type. */
export function DeviceFrameChrome({ type = "iphone", streaming = false }: { type?: DeviceType; streaming?: boolean }) {
  switch (type) {
    case "ipad":
      return <IPadFrameChrome streaming={streaming} />;
    case "watch":
      return <WatchFrameChrome streaming={streaming} />;
    case "vision":
      return <VisionProFrameChrome streaming={streaming} />;
    default:
      return <PhoneFrameChrome streaming={streaming} />;
  }
}

export function PhoneFrameChrome({ streaming = false }: { streaming?: boolean }) {
  return (
    <svg viewBox="0 0 427 881" style={{ width: '100%', height: '100%' }} fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter
          id="chrome-filter0"
          x="-0.166992"
          y="0.166504"
          width="427"
          height="880.667"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="0.5" result="effect1_foregroundBlur" />
        </filter>
        <filter
          id="chrome-filter1"
          x="6.33236"
          y="6.33382"
          width="414"
          height="868"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="0.333333" result="effect1_foregroundBlur" />
        </filter>
      </defs>
      {/* Inner border */}
      <rect
        x="3.83268"
        y="3.83366"
        width="419"
        height="873"
        rx="66.1667"
        stroke="#454548"
        strokeWidth="4.33333"
      />
      {/* Outer border */}
      <rect
        x="0.833333"
        y="0.833333"
        width="425"
        height="879"
        rx="69.1667"
        stroke="#37373a"
        strokeWidth="1.66667"
      />
      {/* Border glow effects */}
      <g opacity="0.9" filter="url(#chrome-filter0)">
        <rect
          x="1.66602"
          y="2"
          width="423.333"
          height="877"
          rx="68.6667"
          stroke="#454548"
          strokeWidth="1.66667"
        />
      </g>
      <g opacity="0.8" filter="url(#chrome-filter1)">
        <rect
          x="7.33268"
          y="7.33366"
          width="412"
          height="866"
          rx="62.6667"
          stroke="#646464"
          strokeWidth="0.666667"
        />
      </g>
      {/* Dynamic Island */}
      <rect x="151.666" y="31.667" width="123.333" height="36" rx="18" fill="black"
        style={{ opacity: streaming ? 0 : 1, transition: 'opacity 0.3s ease' }}
      />
    </svg>
  );
}

function IPadFrameChrome({ streaming = false }: { streaming?: boolean }) {
  const w = DEVICE_FRAMES.ipad.width;
  const h = DEVICE_FRAMES.ipad.height;
  const outerRx = 30;
  const innerRx = 26;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '100%' }} fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="ipad-glow0" x="0" y="0" width={w} height={h} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="0.5" result="blur" />
        </filter>
        <filter id="ipad-glow1" x="5" y="5" width={w - 10} height={h - 10} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="0.333333" result="blur" />
        </filter>
      </defs>
      {/* Inner border */}
      <rect x="3.5" y="3.5" width={w - 7} height={h - 7} rx={innerRx} stroke="#454548" strokeWidth="4" />
      {/* Outer border */}
      <rect x="0.833" y="0.833" width={w - 1.666} height={h - 1.666} rx={outerRx} stroke="#37373a" strokeWidth="1.666" />
      {/* Border glow effects */}
      <g opacity="0.9" filter="url(#ipad-glow0)">
        <rect x="1.5" y="1.5" width={w - 3} height={h - 3} rx={outerRx - 1} stroke="#454548" strokeWidth="1.666" />
      </g>
      <g opacity="0.8" filter="url(#ipad-glow1)">
        <rect x="6" y="6" width={w - 12} height={h - 12} rx={innerRx - 2} stroke="#646464" strokeWidth="0.666" />
      </g>
      {/* Front camera dot */}
      <circle cx={w / 2} cy={DEVICE_FRAMES.ipad.bezelY / 2 + 1} r="3" fill="#1a1a1a"
        style={{ opacity: streaming ? 0 : 0.8, transition: 'opacity 0.3s ease' }}
      />
      {/* Home indicator */}
      <rect
        x={(w - 120) / 2}
        y={h - DEVICE_FRAMES.ipad.bezelY / 2 - 2.5}
        width="120"
        height="5"
        rx="2.5"
        fill="white"
        style={{ opacity: streaming ? 0 : 0.35, mixBlendMode: 'difference', transition: 'opacity 0.3s ease' }}
      />
    </svg>
  );
}

function WatchFrameChrome({ streaming = false }: { streaming?: boolean }) {
  const w = DEVICE_FRAMES.watch.width;
  const h = DEVICE_FRAMES.watch.height;
  // Outer case radius — proportional to real Watch case rounding
  const outerRx = 88;
  const innerRx = 82;
  // Digital crown on the right side
  const crownW = 8;
  const crownH = 36;
  const crownY = h / 2 - crownH / 2 - 16;
  const sideButtonH = 22;
  const sideButtonY = h / 2 - sideButtonH / 2 + 16;

  // viewBox matches the case dimensions exactly so the SVG aligns 1:1 with the
  // data-phone-container in App.tsx (which uses aspectRatio = w/h). The crown
  // and side button extend beyond the right edge via `overflow: visible`, so
  // they can poke out without distorting the case-to-screen alignment.
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '100%', overflow: 'visible' }} fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="watch-glow0" x="0" y="0" width={w + 12} height={h} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="0.5" result="blur" />
        </filter>
      </defs>
      {/* Digital Crown */}
      <rect x={w - 2} y={crownY} width={crownW} height={crownH} rx="3" fill="#2a2a2c" stroke="#454548" strokeWidth="1" />
      {/* Side button */}
      <rect x={w - 1} y={sideButtonY} width={crownW - 2} height={sideButtonH} rx="2.5" fill="#2a2a2c" stroke="#454548" strokeWidth="0.8" />
      {/* Inner border */}
      <rect x="3.5" y="3.5" width={w - 7} height={h - 7} rx={innerRx} stroke="#454548" strokeWidth="3.5" />
      {/* Outer border */}
      <rect x="0.833" y="0.833" width={w - 1.666} height={h - 1.666} rx={outerRx} stroke="#37373a" strokeWidth="1.666" />
      {/* Border glow */}
      <g opacity="0.9" filter="url(#watch-glow0)">
        <rect x="1.5" y="1.5" width={w - 3} height={h - 3} rx={outerRx - 1} stroke="#454548" strokeWidth="1.666" />
      </g>
    </svg>
  );
}

function VisionProFrameChrome({ streaming = false }: { streaming?: boolean }) {
  const w = DEVICE_FRAMES.vision.width;
  const h = DEVICE_FRAMES.vision.height;
  const outerRx = 40;
  const innerRx = 34;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '100%' }} fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="vision-glow0" x="0" y="0" width={w} height={h} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="0.5" result="blur" />
        </filter>
        <filter id="vision-glow1" x="5" y="5" width={w - 10} height={h - 10} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="0.333" result="blur" />
        </filter>
        {/* Visor glass gradient */}
        <linearGradient id="vision-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#555558" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#3a3a3d" stopOpacity="0.1" />
        </linearGradient>
      </defs>
      {/* Subtle glass tint on the bezel */}
      <rect x="0" y="0" width={w} height={h} rx={outerRx} fill="url(#vision-glass)" />
      {/* Inner border */}
      <rect x="3.5" y="3.5" width={w - 7} height={h - 7} rx={innerRx} stroke="#454548" strokeWidth="3" />
      {/* Outer border */}
      <rect x="0.833" y="0.833" width={w - 1.666} height={h - 1.666} rx={outerRx} stroke="#37373a" strokeWidth="1.666" />
      {/* Glow effects */}
      <g opacity="0.9" filter="url(#vision-glow0)">
        <rect x="1.5" y="1.5" width={w - 3} height={h - 3} rx={outerRx - 1} stroke="#454548" strokeWidth="1.666" />
      </g>
      <g opacity="0.8" filter="url(#vision-glow1)">
        <rect x="6" y="6" width={w - 12} height={h - 12} rx={innerRx - 2} stroke="#646464" strokeWidth="0.666" />
      </g>
      {/* Front sensors (EyeSight display area indicator) */}
      <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - 30} ry={h / 2 - 24} stroke="#4a4a4d" strokeWidth="0.5" opacity="0.3"
        style={{ opacity: streaming ? 0 : 0.3, transition: 'opacity 0.3s ease' }}
      />
    </svg>
  );
}
