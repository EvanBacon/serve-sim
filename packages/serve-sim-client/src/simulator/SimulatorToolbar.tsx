import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { SimulatorOrientation } from "../types.js";
import { getDeviceType, type DeviceType } from "./deviceFrames.js";

type ExecFn = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
type RotateFn = (orientation: SimulatorOrientation) => void | Promise<void>;

interface ToolbarContextValue {
  exec: ExecFn;
  onRotate?: RotateFn;
  orientation?: SimulatorOrientation | null;
  deviceUdid?: string | null;
  deviceName?: string | null;
  deviceRuntime?: string | null;
  deviceType: DeviceType;
  streaming: boolean;
  disabled: boolean;
}

const ToolbarContext = createContext<ToolbarContextValue | null>(null);

function useToolbar(component: string): ToolbarContextValue {
  const ctx = useContext(ToolbarContext);
  if (!ctx) {
    throw new Error(`<SimulatorToolbar.${component}> must be rendered inside <SimulatorToolbar>`);
  }
  return ctx;
}

export interface SimulatorToolbarProps extends HTMLAttributes<HTMLDivElement> {
  exec: ExecFn;
  /** Optional direct rotate handler. Defaults to shelling out to `serve-sim rotate`. */
  onRotate?: RotateFn;
  /** Current requested orientation, when known. Keeps the built-in rotate button in sync. */
  orientation?: SimulatorOrientation | null;
  deviceUdid?: string | null;
  deviceName?: string | null;
  deviceRuntime?: string | null;
  /** Whether the stream is currently delivering frames. Disables action buttons when false. */
  streaming?: boolean;
  /** Force the whole toolbar into a disabled state (e.g. gateway not connected). */
  disabled?: boolean;
  children?: ReactNode;
}

const toolbarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "4px 12px",
  padding: "8px 12px",
  borderRadius: 24,
  background: "#1c1c1e",
  border: "1px solid rgba(255,255,255,0.1)",
  boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
  minWidth: 240,
  width: "100%",
};

function SimulatorToolbarRoot({
  exec,
  onRotate,
  orientation,
  deviceUdid,
  deviceName,
  deviceRuntime,
  streaming = false,
  disabled = false,
  children,
  style,
  ...rest
}: SimulatorToolbarProps) {
  const deviceType = getDeviceType(deviceName);
  const effectiveDisabled = disabled || !deviceUdid || !streaming;
  const value: ToolbarContextValue = {
    exec,
    onRotate,
    orientation,
    deviceUdid,
    deviceName,
    deviceRuntime,
    deviceType,
    streaming,
    disabled: effectiveDisabled,
  };

  return (
    <ToolbarContext.Provider value={value}>
      <div data-simulator-toolbar style={{ ...toolbarStyle, ...style }} {...rest}>
        {children}
      </div>
    </ToolbarContext.Provider>
  );
}

// -- Title --------------------------------------------------------------

export interface TitleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "name"> {
  /** Override the rendered name. Defaults to the device name from context. */
  name?: ReactNode;
  /** Override the rendered subtitle. Defaults to the device runtime from context. */
  subtitle?: ReactNode;
  /** Hide the chevron hint (e.g. when not interactive). */
  hideChevron?: boolean;
}

const titleButtonStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  textAlign: "left",
  background: "transparent",
  border: "none",
  color: "#fff",
  padding: "2px 4px",
  margin: "-2px -4px",
  borderRadius: 6,
  cursor: "pointer",
  minWidth: 0,
  maxWidth: "100%",
  lineHeight: 1.2,
  fontFamily: "inherit",
};

const Title = forwardRef<HTMLButtonElement, TitleProps>(function Title(
  { name, subtitle, hideChevron, style, onMouseEnter, onMouseLeave, ...rest },
  ref,
) {
  const ctx = useToolbar("Title");
  const [hover, setHover] = useState(false);
  const displayName = name ?? ctx.deviceName ?? "No simulator";
  const displaySubtitle =
    subtitle ?? (ctx.deviceRuntime ? ctx.deviceRuntime.replace(/\./, " ") : "—");

  return (
    <button
      ref={ref}
      type="button"
      data-simulator-toolbar-title
      onMouseEnter={(e) => {
        setHover(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHover(false);
        onMouseLeave?.(e);
      }}
      style={{
        ...titleButtonStyle,
        background: hover ? "rgba(255,255,255,0.1)" : "transparent",
        ...style,
      }}
      {...rest}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 12,
          fontWeight: 600,
          color: "#fff",
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {displayName}
        {!hideChevron && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "rgba(255,255,255,0.6)", flexShrink: 0 }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </span>
      <span
        style={{
          fontSize: 10,
          color: "rgba(255,255,255,0.5)",
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {displaySubtitle}
      </span>
    </button>
  );
});

// -- Actions container --------------------------------------------------

const actionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
};

function Actions({ style, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div style={{ ...actionsStyle, ...style }} {...rest} />;
}

// -- Icon button base ---------------------------------------------------

export interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Force disabled even if the toolbar is ready. */
  forceDisabled?: boolean;
}

const buttonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 6,
  borderRadius: 6,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "rgba(255,255,255,0.8)",
  transition: "background-color 0.15s, color 0.15s",
};

const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(
  { forceDisabled, style, disabled, onMouseEnter, onMouseLeave, children, ...rest },
  ref,
) {
  const ctx = useContext(ToolbarContext);
  const effectiveDisabled = disabled || forceDisabled || ctx?.disabled;
  const [hover, setHover] = useState(false);

  return (
    <button
      ref={ref}
      type="button"
      disabled={effectiveDisabled}
      onMouseEnter={(e) => {
        setHover(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHover(false);
        onMouseLeave?.(e);
      }}
      style={{
        ...buttonStyle,
        color: effectiveDisabled ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.8)",
        background:
          hover && !effectiveDisabled ? "rgba(255,255,255,0.1)" : "transparent",
        cursor: effectiveDisabled ? "not-allowed" : "pointer",
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
});

// Trigger Simulator.app's Device > Home menu item against the watchOS window.
// Raises the watch window, sets Simulator as frontmost, then clicks the menu
// item — this is the only mechanism that actually returns a watchOS simulator
// to the watch face.
function watchHomeAppleScript(): string {
  const args = [
    'tell application "System Events" to tell process "Simulator" to set frontmost to true',
    'tell application "System Events" to tell process "Simulator" to perform action "AXRaise" of (first window whose name contains "watchOS")',
    'tell application "System Events" to tell process "Simulator" to click menu item "Home" of menu "Device" of menu bar item "Device" of menu bar 1',
  ];
  return args.map((a) => `-e '${a}'`).reduce((acc, a) => `${acc} ${a}`, "osascript");
}

// Orientation cycle for the rotate button. Counter-clockwise ("Rotate Left"
// in Simulator.app), matching the familiar Cmd+Left behavior. Values are
// delivered to the guest as UIDeviceOrientation values via serve-sim's
// PurpleWorkspacePort bridge — see HIDInjector.sendOrientation on the Swift
// side.
const ROTATE_LEFT_CYCLE: Record<SimulatorOrientation, SimulatorOrientation> = {
  portrait: "landscape_left",
  landscape_left: "portrait_upside_down",
  portrait_upside_down: "landscape_right",
  landscape_right: "portrait",
};

// -- Built-in action buttons -------------------------------------------

const HomeIcon = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z" />
  </svg>
);

const ScreenshotIcon = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const RotateIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 5H6a2 2 0 0 0-2 2v3" />
    <path d="m9 8 3-3-3-3" />
    <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
  </svg>
);

const HomeButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function HomeButton(
  { onClick, ...rest },
  ref,
) {
  const ctx = useToolbar("HomeButton");
  return (
    <ToolbarButton
      ref={ref}
      aria-label="Home"
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        // Apple Watch simulators ignore the HID button 0 that serve-sim sends.
        // Simctl has no hardware-button command, and no launchable bundle id
        // reliably returns to the watch face (Carousel/Mandrake both fail or
        // show "Feature not available"). The working approach is to trigger
        // Simulator.app's Device > Home menu item against the raised watchOS
        // window via AppleScript — that dispatches through homeButtonPressed:
        // which does reach the watch face.
        if (ctx.deviceType === "watch") {
          void ctx.exec(watchHomeAppleScript());
        } else {
          void ctx.exec("serve-sim button home");
        }
      }}
      {...rest}
    >
      {HomeIcon}
    </ToolbarButton>
  );
});

const ScreenshotButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ScreenshotButton(
  { onClick, ...rest },
  ref,
) {
  const ctx = useToolbar("ScreenshotButton");
  return (
    <ToolbarButton
      ref={ref}
      aria-label="Screenshot"
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        if (ctx.deviceUdid) {
          void ctx.exec(
            `xcrun simctl io ${ctx.deviceUdid} screenshot ~/Desktop/serve-sim-screenshot-$(date +%s).png`,
          );
        }
      }}
      {...rest}
    >
      {ScreenshotIcon}
    </ToolbarButton>
  );
});

const RotateButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function RotateButton(
  { onClick, forceDisabled, ...rest },
  ref,
) {
  const ctx = useToolbar("RotateButton");
  const cantRotate = ctx.deviceType === "watch" || ctx.deviceType === "vision";
  // Reset the cycle when the device changes — each sim boots in portrait.
  const [orientation, setOrientation] = useState<SimulatorOrientation>("portrait");
  useEffect(() => {
    setOrientation(ctx.orientation ?? "portrait");
  }, [ctx.deviceUdid, ctx.orientation]);

  return (
    <ToolbarButton
      ref={ref}
      aria-label="Rotate device"
      forceDisabled={forceDisabled || cantRotate}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        if (!ctx.deviceUdid || cantRotate) return;
        const next = ROTATE_LEFT_CYCLE[ctx.orientation ?? orientation];
        setOrientation(next);
        if (ctx.onRotate) {
          void ctx.onRotate(next);
        } else {
          void ctx.exec(`serve-sim rotate ${next} -d ${ctx.deviceUdid}`);
        }
      }}
      {...rest}
    >
      {RotateIcon}
    </ToolbarButton>
  );
});

type SimulatorToolbarCompound = typeof SimulatorToolbarRoot & {
  Title: typeof Title;
  Actions: typeof Actions;
  Button: typeof ToolbarButton;
  HomeButton: typeof HomeButton;
  ScreenshotButton: typeof ScreenshotButton;
  RotateButton: typeof RotateButton;
};

export const SimulatorToolbar = SimulatorToolbarRoot as SimulatorToolbarCompound;
SimulatorToolbar.Title = Title;
SimulatorToolbar.Actions = Actions;
SimulatorToolbar.Button = ToolbarButton;
SimulatorToolbar.HomeButton = HomeButton;
SimulatorToolbar.ScreenshotButton = ScreenshotButton;
SimulatorToolbar.RotateButton = RotateButton;
