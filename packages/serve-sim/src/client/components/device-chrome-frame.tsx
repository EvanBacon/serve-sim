import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  DeviceKitChromeButton,
  DeviceKitChromeDescriptor,
  GridRect,
} from "../utils/grid";
import { simEndpoint } from "../utils/sim-endpoint";

// Shared DeviceKit chrome renderer. Lays everything out in the chrome's own
// frame coordinate space (every piece positioned as a percentage of
// `chrome.frame`), so the bezel, screen, and hardware buttons stay aligned at
// any rendered size. Used by both the offline placeholder (static) and the live
// stream view (interactive buttons + a real stream in the screen slot).

export type ChromeButtonPress = {
  /** "down" on press, "up" on release. Lets the caller hold power / side
   *  buttons for their long-press menus. */
  phase: "down" | "up";
  button: DeviceKitChromeButton;
};

export function DeviceKitChrome({
  chrome,
  screen,
  interactive = false,
  onButton,
}: {
  chrome: DeviceKitChromeDescriptor;
  /** Rendered inside the screen cutout (the live stream, or a black fill). */
  screen?: ReactNode;
  interactive?: boolean;
  onButton?: (press: ChromeButtonPress) => void;
}) {
  // Apple's composite pictures only the bezel — the hardware buttons are
  // separate sprites that poke out past the metal edge (the part overshooting
  // the bezel is what's visible). So every button is always drawn; `onTop` ones
  // (watch crown / side / action) sit above the bezel, the rest behind it.
  return (
    <div className="absolute inset-0">
      {chrome.buttons.map((button) => (
        <ChromeButton
          key={`button-${button.name}`}
          chrome={chrome}
          button={button}
          interactive={interactive}
          onButton={onButton}
        />
      ))}

      {/* The screen sits UNDER the bezel (z1): the live stream renders here and
          the bezel's screen region is masked transparent (below) so the bezel's
          rounded inner edge frames the screen on top, rather than the stream
          covering the bezel. */}
      <div
        className="absolute overflow-hidden bg-black"
        style={{
          ...rectStyle(chrome, chrome.screen, 1),
          borderRadius: deviceKitScreenRadius(chrome),
        }}
      >
        {screen}
      </div>

      {chrome.compositeImage ? (
        <ChromeImage
          chrome={chrome}
          image={chrome.compositeImage}
          rect={chrome.body}
          zIndex={2}
          maskCss={screenHoleMask(chrome)}
        />
      ) : chrome.slice && chrome.corner ? (
        <NineSliceChrome chrome={chrome} />
      ) : null}
    </div>
  );
}

/** CSS border-radius for the screen cutout, matched to its measured corner radius. */
export function deviceKitScreenRadius(chrome: DeviceKitChromeDescriptor): string {
  return `${(chrome.screenRadius / chrome.screen.width) * 100}% / ${
    (chrome.screenRadius / chrome.screen.height) * 100
  }%`;
}

/**
 * A CSS mask that punches the screen opening out of the composite bezel, so the
 * stream rendered behind it shows through and the bezel frames it on top. The
 * SVG is opaque (alpha 1) everywhere except a rounded rect over the screen
 * (alpha 0), in the composite image's own (body) coordinate space.
 */
function screenHoleMask(chrome: DeviceKitChromeDescriptor): string {
  const bw = chrome.body.width;
  const bh = chrome.body.height;
  const hx = chrome.screen.x - chrome.body.x;
  const hy = chrome.screen.y - chrome.body.y;
  const hw = chrome.screen.width;
  const hh = chrome.screen.height;
  const r = Math.max(0, Math.min(chrome.screenRadius, hw / 2, hh / 2));
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${bw} ${bh}' preserveAspectRatio='none'>` +
    `<path fill='#000' fill-rule='evenodd' d='M0 0H${bw}V${bh}H0Z` +
    `M${hx + r} ${hy}H${hx + hw - r}A${r} ${r} 0 0 1 ${hx + hw} ${hy + r}` +
    `V${hy + hh - r}A${r} ${r} 0 0 1 ${hx + hw - r} ${hy + hh}` +
    `H${hx + r}A${r} ${r} 0 0 1 ${hx} ${hy + hh - r}` +
    `V${hy + r}A${r} ${r} 0 0 1 ${hx + r} ${hy}Z'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function ChromeButton({
  chrome,
  button,
  interactive,
  onButton,
}: {
  chrome: DeviceKitChromeDescriptor;
  button: DeviceKitChromeButton;
  interactive: boolean;
  onButton?: (press: ChromeButtonPress) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const activePointerRef = useRef<number | null>(null);
  // A button is only pressable when it carries a HID code; decorative inputs
  // (rare) still render but don't intercept pointer events.
  const pressable = interactive && button.usagePage != null && button.usage != null;

  const release = useCallback(() => {
    if (activePointerRef.current === null) return;
    activePointerRef.current = null;
    setPressed(false);
    onButton?.({ phase: "up", button });
  }, [button, onButton]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      event.preventDefault();
      event.stopPropagation();
      activePointerRef.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
      setPressed(true);
      onButton?.({ phase: "down", button });
    },
    [button, onButton],
  );

  // zIndex relative to bezel (z2) and screen (z3): raised caps (watch crown /
  // side / action, which sit in a bezel cutout) are drawn ABOVE the bezel so the
  // whole cap shows; the rest sit behind it (z0) so only the overshoot past the
  // solid edge shows. All buttons are on the side rails, clear of the screen.
  const zIndex = button.raised ? 5 : 0;

  // The cap slides out on hover/press by its rollover travel; the depressed
  // sprite (or a brightened cap) reads the press.
  const active = pressable && (hovered || pressed);
  const tx = (active ? button.hover.x : 0) * 100;
  const ty = (active ? button.hover.y : 0) * 100;
  const sprite = pressed && button.imageDown ? button.imageDown : button.image;

  const handlers = pressable
    ? {
        onPointerDown,
        onPointerUp: release,
        onPointerCancel: release,
        onPointerEnter: () => setHovered(true),
        onPointerLeave: () => {
          setHovered(false);
          release();
        },
      }
    : {};

  return (
    <div
      role={pressable ? "button" : undefined}
      aria-label={pressable ? buttonLabel(button.name) : undefined}
      aria-hidden={pressable ? undefined : true}
      title={pressable ? buttonLabel(button.name) : undefined}
      className="absolute select-none"
      style={{
        ...rectStyle(chrome, button.frame, zIndex),
        transform: tx || ty ? `translate(${tx}%, ${ty}%)` : undefined,
        transition: "transform 0.12s ease",
        cursor: pressable ? "pointer" : undefined,
        pointerEvents: pressable ? "auto" : "none",
        touchAction: "none",
      }}
      {...handlers}
    >
      {sprite && (
        <img
          alt=""
          aria-hidden
          draggable={false}
          src={chromeAssetUrl(chrome.identifier, sprite)}
          className="absolute inset-0 size-full select-none"
          style={{
            objectFit: "fill",
            // Without a dedicated pressed sprite, brighten so the press still
            // reads (no low-opacity dimming, per house style).
            filter: pressed && !button.imageDown ? "brightness(1.4)" : undefined,
            transition: "filter 0.12s ease",
            WebkitUserDrag: "none",
          } as CSSProperties}
        />
      )}
    </div>
  );
}

function buttonLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function NineSliceChrome({ chrome }: { chrome: DeviceKitChromeDescriptor }) {
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
      rect: { x: body.x + corner.width, y: body.y, width: midWidth, height: corner.height },
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
      rect: { x: body.x, y: body.y + corner.height, width: corner.width, height: midHeight },
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

export function ChromeImage({
  chrome,
  image,
  rect,
  zIndex,
  maskCss,
}: {
  chrome: DeviceKitChromeDescriptor;
  image: string;
  rect: GridRect;
  zIndex: number;
  /** Optional CSS mask (e.g. punching the screen hole out of the bezel). */
  maskCss?: string;
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
        // The bezel must never swallow taps meant for the screen / buttons.
        pointerEvents: "none",
        WebkitUserDrag: "none",
        ...(maskCss
          ? {
              maskImage: maskCss,
              WebkitMaskImage: maskCss,
              maskSize: "100% 100%",
              WebkitMaskSize: "100% 100%",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
            }
          : {}),
      } as CSSProperties}
    />
  );
}

export function chromeAssetUrl(identifier: string, image: string): string {
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
