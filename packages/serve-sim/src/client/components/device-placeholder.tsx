import {
  DEVICE_FRAMES,
  DeviceFrameChrome,
  fallbackScreenSize,
  getDeviceType,
  simulatorMaxWidth,
} from "serve-sim-client/simulator";
import { useState, type CSSProperties, type ReactNode } from "react";
import type {
  DeviceKitChromeDescriptor,
  DevicePlaceholderAssetDescriptor,
  GridRect,
} from "../utils/grid";
import { runtimeLabel } from "../utils/grid";
import { simEndpoint } from "../utils/sim-endpoint";

// Shown in the main view when the selected device isn't streaming yet: a static
// device frame, the device name + runtime, and a Start button that boots/streams
// it. Mirrors Xcode's "device not running" state.
export function DevicePlaceholder({
  name,
  runtime,
  chrome,
  placeholderAsset,
  busy,
  busyLabel = "Starting…",
  error,
  onStart,
}: {
  name: string;
  runtime: string;
  chrome?: DeviceKitChromeDescriptor | null;
  placeholderAsset?: DevicePlaceholderAssetDescriptor | null;
  busy: boolean;
  busyLabel?: string;
  error: string | null;
  onStart: () => void;
}) {
  const type = getDeviceType(name);
  const f = DEVICE_FRAMES[type];
  const activeAsset = placeholderAsset ?? null;
  const activeChrome = activeAsset ? null : chrome ?? null;
  const screenSize = activeChrome
    ? { width: activeChrome.screen.width, height: activeChrome.screen.height }
    : fallbackScreenSize(type, name);
  const screenMax = simulatorMaxWidth(type, screenSize);
  const frameMaxWidth = activeAsset
    ? placeholderAssetMaxWidth(type, activeAsset.name)
    : activeChrome
    ? (screenMax * activeChrome.frame.width) / activeChrome.screen.width
    : (screenMax * f.width) / (f.width - 2 * f.bezelX);
  const aspectSize = activeAsset
    ? { width: activeAsset.width, height: activeAsset.height }
    : activeChrome
    ? { width: activeChrome.frame.width, height: activeChrome.frame.height }
    : { width: f.width, height: f.height };
  const aspectRatio = `${aspectSize.width} / ${aspectSize.height}`;
  const viewportWidthLimit = (
    (aspectSize.width / aspectSize.height) * placeholderAssetMaxViewportHeight(type)
  ).toFixed(2);
  const fallbackChrome = type === "vision"
    ? <VisionPlaceholderFallback />
    : <SvgPlaceholderChrome type={type} />;

  return (
    <div className="flex flex-col items-center gap-5 min-w-0 w-full">
      <div
        className="relative w-full"
        style={{
          width: `min(100%, ${frameMaxWidth}px, ${viewportWidthLimit}dvh)`,
          maxWidth: frameMaxWidth,
          aspectRatio,
        }}
      >
        {activeAsset ? (
          <AssetPlaceholderChrome name={activeAsset.name} fallback={fallbackChrome} />
        ) : activeChrome ? (
          <DeviceKitPlaceholderChrome chrome={activeChrome} />
        ) : (
          fallbackChrome
        )}
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <div className="text-[17px] font-semibold text-white/90">{name}</div>
        <div className="text-[13px] text-white/45">{runtimeLabel(runtime)} Simulator</div>
      </div>

      {error && <div className="text-danger text-[12px] font-mono max-w-90 text-center">{error}</div>}

      <button
        type="button"
        onClick={onStart}
        disabled={busy}
        className={`flex items-center gap-2 px-5 py-2 rounded-full text-[14px] font-medium [transition:background_0.15s] ${
          busy
            ? "bg-white/8 text-white/55 cursor-default"
            : "bg-white/12 text-white/90 hover:bg-white/18 cursor-pointer"
        }`}
      >
        {busy && (
          <span
            aria-hidden
            className="size-3.5 rounded-full border-2 border-white/25 animate-[grid-spin_0.8s_linear_infinite]"
            style={{ borderTopColor: "rgba(255,255,255,0.9)" }}
          />
        )}
        {busy ? busyLabel : "Start"}
      </button>
    </div>
  );
}

function placeholderAssetMaxWidth(
  type: ReturnType<typeof getDeviceType>,
  assetName: string,
): number {
  if (type === "watch") {
    if (assetName.includes("ultra")) return 255;
    if (assetName.includes("watch-se-") || assetName.includes("apple-watch-se-")) return 238;
    return 250;
  }
  if (type === "vision") return 390;
  if (type === "ipad") return 340;
  return 280;
}

function placeholderAssetMaxViewportHeight(type: ReturnType<typeof getDeviceType>): number {
  if (type === "vision") return 34;
  if (type === "ipad") return 50;
  if (type === "watch") return 56;
  return 52;
}

function SvgPlaceholderChrome({ type }: { type: ReturnType<typeof getDeviceType> }) {
  const f = DEVICE_FRAMES[type];
  // Draw the blank screen in the SAME coordinate space as the chrome SVG (the
  // device frame's own viewBox), so the bezel and the screen always line up.
  return (
    <>
      <svg
        viewBox={`0 0 ${f.width} ${f.height}`}
        className="absolute inset-0 size-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id="placeholder-screen" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6fa8e6" />
            <stop offset="55%" stopColor="#5b93d6" />
            <stop offset="100%" stopColor="#5188cf" />
          </linearGradient>
        </defs>
        <rect
          x={f.bezelX}
          y={f.bezelY}
          width={f.width - 2 * f.bezelX}
          height={f.height - 2 * f.bezelY}
          rx={f.innerRadius}
          fill="url(#placeholder-screen)"
        />
      </svg>
      <div className="absolute inset-0 pointer-events-none">
        <DeviceFrameChrome type={type} />
      </div>
    </>
  );
}

function AssetPlaceholderChrome({
  name,
  fallback,
}: {
  name: string;
  fallback: ReactNode;
}) {
  const [assetState, setAssetState] = useState<"loading" | "loaded" | "error">("loading");

  return (
    <div className="absolute inset-0 size-full pointer-events-none">
      {assetState !== "loaded" && fallback}
      {assetState !== "error" && (
        <img
          alt=""
          aria-hidden
          draggable={false}
          src={placeholderAssetUrl(name)}
          className="absolute inset-0 size-full select-none object-contain"
          style={{ WebkitUserDrag: "none" } as CSSProperties}
          onLoad={() => setAssetState("loaded")}
          onError={() => setAssetState("error")}
        />
      )}
    </div>
  );
}

function VisionPlaceholderFallback() {
  const { width: w, height: h } = DEVICE_FRAMES.vision;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="absolute inset-0 size-full"
      preserveAspectRatio="xMidYMid meet"
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="vision-placeholder-shell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#28282b" />
          <stop offset="54%" stopColor="#121214" />
          <stop offset="100%" stopColor="#070708" />
        </linearGradient>
        <linearGradient id="vision-placeholder-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#31353a" />
          <stop offset="48%" stopColor="#0a0b0d" />
          <stop offset="100%" stopColor="#010102" />
        </linearGradient>
        <radialGradient id="vision-placeholder-lens" cx="50%" cy="46%" r="60%">
          <stop offset="0%" stopColor="#202832" />
          <stop offset="72%" stopColor="#090a0d" />
          <stop offset="100%" stopColor="#010102" />
        </radialGradient>
      </defs>
      <path
        d="M95 177C95 119 147 86 218 91C257 94 286 111 320 111C354 111 383 94 422 91C493 86 545 119 545 177V222C545 278 501 311 443 310C398 309 371 286 345 268C329 257 311 257 295 268C269 286 242 309 197 310C139 311 95 278 95 222V177Z"
        fill="url(#vision-placeholder-shell)"
        stroke="#3d3d42"
        strokeWidth="7"
      />
      <path
        d="M117 181C117 134 157 112 220 116C260 119 287 136 320 136C353 136 380 119 420 116C483 112 523 134 523 181V217C523 263 488 287 439 287C399 287 369 264 345 250C329 240 311 240 295 250C271 264 241 287 201 287C152 287 117 263 117 217V181Z"
        fill="url(#vision-placeholder-glass)"
        stroke="#17181b"
        strokeWidth="5"
      />
      <path
        d="M143 186C145 148 176 135 226 138C264 141 289 156 320 156C351 156 376 141 414 138C464 135 495 148 497 186V213C497 250 469 266 432 266C394 266 369 246 343 235C328 229 312 229 297 235C271 246 246 266 208 266C171 266 143 250 143 213V186Z"
        fill="url(#vision-placeholder-lens)"
        stroke="#262a2f"
        strokeWidth="2"
      />
      <path
        d="M151 171C179 150 217 147 251 154M389 154C423 147 461 150 489 171"
        stroke="#4e535a"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M277 233C289 224 304 219 320 219C336 219 351 224 363 233"
        stroke="#3b4046"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DeviceKitPlaceholderChrome({ chrome }: { chrome: DeviceKitChromeDescriptor }) {
  const screenRadius = `${(chrome.innerCornerRadius / chrome.screen.width) * 100}% / ${
    (chrome.innerCornerRadius / chrome.screen.height) * 100
  }%`;
  const buttons = chrome.compositeImage
    ? chrome.buttons.filter((button) => button.onTop)
    : chrome.buttons;

  return (
    <div className="absolute inset-0 pointer-events-none">
      {buttons.map((button) => (
        <ChromeImage
          key={`button-${button.name}`}
          chrome={chrome}
          image={button.image}
          rect={button.frame}
          zIndex={button.onTop ? 4 : 0}
        />
      ))}

      <div
        className="absolute bg-black"
        style={{
          ...rectStyle(chrome, chrome.screen, 1),
          borderRadius: screenRadius,
        }}
      />

      {chrome.compositeImage ? (
        <ChromeImage
          chrome={chrome}
          image={chrome.compositeImage}
          rect={chrome.body}
          zIndex={2}
        />
      ) : chrome.slice && chrome.corner ? (
        <NineSliceChrome chrome={chrome} />
      ) : null}
    </div>
  );
}

function NineSliceChrome({ chrome }: { chrome: DeviceKitChromeDescriptor }) {
  if (!chrome.slice || !chrome.corner) return null;
  const { body, corner, slice } = chrome;
  const midWidth = Math.max(body.width - corner.width * 2, 0);
  const midHeight = Math.max(body.height - corner.height * 2, 0);
  const pieces: Array<{ key: string; image: string; rect: GridRect }> = [
    {
      key: "top-left",
      image: slice.topLeft,
      rect: { x: body.x, y: body.y, width: corner.width, height: corner.height },
    },
    {
      key: "top-right",
      image: slice.topRight,
      rect: {
        x: body.x + body.width - corner.width,
        y: body.y,
        width: corner.width,
        height: corner.height,
      },
    },
    {
      key: "bottom-left",
      image: slice.bottomLeft,
      rect: {
        x: body.x,
        y: body.y + body.height - corner.height,
        width: corner.width,
        height: corner.height,
      },
    },
    {
      key: "bottom-right",
      image: slice.bottomRight,
      rect: {
        x: body.x + body.width - corner.width,
        y: body.y + body.height - corner.height,
        width: corner.width,
        height: corner.height,
      },
    },
    {
      key: "top",
      image: slice.top,
      rect: {
        x: body.x + corner.width,
        y: body.y,
        width: midWidth,
        height: corner.height,
      },
    },
    {
      key: "bottom",
      image: slice.bottom,
      rect: {
        x: body.x + corner.width,
        y: body.y + body.height - corner.height,
        width: midWidth,
        height: corner.height,
      },
    },
    {
      key: "left",
      image: slice.left,
      rect: {
        x: body.x,
        y: body.y + corner.height,
        width: corner.width,
        height: midHeight,
      },
    },
    {
      key: "right",
      image: slice.right,
      rect: {
        x: body.x + body.width - corner.width,
        y: body.y + corner.height,
        width: corner.width,
        height: midHeight,
      },
    },
  ];

  return (
    <>
      {pieces
        .filter((piece) => piece.rect.width > 0 && piece.rect.height > 0)
        .map((piece) => (
          <ChromeImage
            key={piece.key}
            chrome={chrome}
            image={piece.image}
            rect={piece.rect}
            zIndex={2}
          />
        ))}
    </>
  );
}

function ChromeImage({
  chrome,
  image,
  rect,
  zIndex,
}: {
  chrome: DeviceKitChromeDescriptor;
  image: string;
  rect: GridRect;
  zIndex: number;
}) {
  return (
    <img
      alt=""
      aria-hidden
      draggable={false}
      src={chromeAssetUrl(chrome.identifier, image)}
      className="absolute select-none"
      style={{
        ...rectStyle(chrome, rect, zIndex),
        objectFit: "fill",
        WebkitUserDrag: "none",
      } as CSSProperties}
    />
  );
}

function chromeAssetUrl(identifier: string, image: string): string {
  const path = `grid/api/devicekit-chrome?chrome=${encodeURIComponent(identifier)}&image=${encodeURIComponent(image)}`;
  return typeof window === "undefined" ? `/${path}` : simEndpoint(path);
}

function placeholderAssetUrl(name: string): string {
  const path = `grid/api/device-placeholder-asset?name=${encodeURIComponent(name)}`;
  return typeof window === "undefined" ? `/${path}` : simEndpoint(path);
}

function rectStyle(
  chrome: DeviceKitChromeDescriptor,
  rect: GridRect,
  zIndex: number,
): CSSProperties {
  return {
    left: pct(rect.x, chrome.frame.width),
    top: pct(rect.y, chrome.frame.height),
    width: pct(rect.width, chrome.frame.width),
    height: pct(rect.height, chrome.frame.height),
    zIndex,
  };
}

function pct(value: number, total: number): string {
  return `${(value / total) * 100}%`;
}
