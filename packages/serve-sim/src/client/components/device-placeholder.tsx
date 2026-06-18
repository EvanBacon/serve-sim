import {
  DEVICE_FRAMES,
  DeviceFrameChrome,
  fallbackScreenSize,
  getDeviceType,
  simulatorMaxWidth,
} from "serve-sim-client/simulator";
import type { CSSProperties } from "react";
import type { DeviceKitChromeDescriptor, GridRect } from "../utils/grid";
import { runtimeLabel } from "../utils/grid";
import { simEndpoint } from "../utils/sim-endpoint";

// Shown in the main view when the selected device isn't streaming yet: a static
// device frame with a blank blue screen, the device name + runtime, and a Start
// button that boots/streams it. Mirrors Xcode's "device not running" state.
export function DevicePlaceholder({
  name,
  runtime,
  chrome,
  busy,
  busyLabel = "Starting…",
  error,
  onStart,
}: {
  name: string;
  runtime: string;
  chrome?: DeviceKitChromeDescriptor | null;
  busy: boolean;
  busyLabel?: string;
  error: string | null;
  onStart: () => void;
}) {
  const type = getDeviceType(name);
  const f = DEVICE_FRAMES[type];
  const screenSize = chrome
    ? { width: chrome.screen.width, height: chrome.screen.height }
    : fallbackScreenSize(type, name);
  const screenMax = simulatorMaxWidth(type, screenSize);
  const frameMaxWidth = chrome
    ? (screenMax * chrome.frame.width) / chrome.screen.width
    : (screenMax * f.width) / (f.width - 2 * f.bezelX);
  const aspectRatio = chrome
    ? `${chrome.frame.width} / ${chrome.frame.height}`
    : `${f.width} / ${f.height}`;

  return (
    <div className="flex flex-col items-center gap-5 min-w-0">
      <div
        className="relative w-full"
        style={{ maxWidth: frameMaxWidth, aspectRatio }}
      >
        {chrome ? <DeviceKitPlaceholderChrome chrome={chrome} /> : <SvgPlaceholderChrome type={type} />}
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

function DeviceKitPlaceholderChrome({ chrome }: { chrome: DeviceKitChromeDescriptor }) {
  const screenRadius = `${(chrome.innerCornerRadius / chrome.screen.width) * 100}% / ${
    (chrome.innerCornerRadius / chrome.screen.height) * 100
  }%`;

  return (
    <div className="absolute inset-0 pointer-events-none">
      {chrome.buttons.map((button) => (
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
