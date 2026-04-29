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
import { getDeviceType, type DeviceType } from "./deviceFrames.js";

type ExecFn = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

interface ToolbarContextValue {
  exec: ExecFn;
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

export interface TitleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
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
type Orientation =
  | "portrait"
  | "landscape_left"
  | "portrait_upside_down"
  | "landscape_right";

const ROTATE_LEFT_CYCLE: Record<Orientation, Orientation> = {
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
  <svg width="18" height="18" viewBox="0 0 12 13" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M10.2305 12.8077H4.42383C3.92383 12.8077 3.54688 12.6846 3.29297 12.4385C3.04297 12.1963 2.91797 11.8194 2.91797 11.3077V5.51274C2.91797 4.99711 3.04297 4.61821 3.29297 4.37602C3.54688 4.12993 3.92383 4.00688 4.42383 4.00688H10.2305C10.7344 4.00688 11.1113 4.12993 11.3613 4.37602C11.6113 4.61821 11.7363 4.99711 11.7363 5.51274V11.3077C11.7363 11.8194 11.6113 12.1963 11.3613 12.4385C11.1113 12.6846 10.7344 12.8077 10.2305 12.8077ZM10.2129 11.8643C10.416 11.8643 10.5625 11.8194 10.6523 11.7295C10.7461 11.6436 10.793 11.4971 10.793 11.2901V5.52446C10.793 5.31743 10.7461 5.17094 10.6523 5.08501C10.5625 4.99516 10.416 4.95024 10.2129 4.95024H4.44141C4.24219 4.95024 4.0957 4.99516 4.00195 5.08501C3.9082 5.17094 3.86133 5.31743 3.86133 5.52446V11.2901C3.86133 11.4971 3.9082 11.6436 4.00195 11.7295C4.0957 11.8194 4.24219 11.8643 4.44141 11.8643H10.2129ZM2.91797 2.58305V0.415083C2.91797 0.20024 2.98633 0.0693803 3.12305 0.0225053C3.25977 -0.0282759 3.41016 0.00688033 3.57422 0.127974L5.05078 1.21196C5.17578 1.30571 5.23828 1.40141 5.23828 1.49907C5.23828 1.59672 5.17578 1.69243 5.05078 1.78618L3.57422 2.8643C3.41016 2.9854 3.25977 3.02251 3.12305 2.97563C2.98633 2.92485 2.91797 2.79399 2.91797 2.58305ZM3.5332 1.15336C3.62695 1.15336 3.70703 1.18657 3.77344 1.25297C3.84375 1.31938 3.87891 1.39751 3.87891 1.48735C3.87891 1.5811 3.84375 1.66313 3.77344 1.73344C3.70703 1.79985 3.62695 1.83305 3.5332 1.83305H2.80664C2.38086 1.83305 2.01172 1.92485 1.69922 2.10844C1.39062 2.28813 1.15234 2.53813 0.984375 2.85844C0.816406 3.17876 0.732422 3.54594 0.732422 3.96001V4.83891C0.732422 4.93657 0.697266 5.02251 0.626953 5.09672C0.552734 5.16704 0.464844 5.20219 0.363281 5.20219C0.265625 5.20219 0.181641 5.16704 0.111328 5.09672C0.0371094 5.02251 0 4.93657 0 4.83891V3.96001C0 3.40141 0.117188 2.91118 0.351562 2.4893C0.582031 2.06743 0.908203 1.7393 1.33008 1.50493C1.74805 1.27055 2.23828 1.15336 2.80078 1.15336H3.5332Z" />
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
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  useEffect(() => {
    setOrientation("portrait");
  }, [ctx.deviceUdid]);

  return (
    <ToolbarButton
      ref={ref}
      aria-label="Rotate device"
      forceDisabled={forceDisabled || cantRotate}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        if (!ctx.deviceUdid || cantRotate) return;
        const next = ROTATE_LEFT_CYCLE[orientation];
        setOrientation(next);
        void ctx.exec(`serve-sim rotate ${next} -d ${ctx.deviceUdid}`);
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
