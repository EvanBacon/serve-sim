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

// Camera-in-viewfinder "capture" glyph (filled), matching the macOS-style icon.
const ScreenshotIcon = (
  <svg width="18" height="18" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      fill="currentColor"
      d="M43.6875 12.4688V8.27344C43.6875 5.72656 42.9531 3.71094 41.4844 2.22656C40.0156 0.742188 38 0 35.4375 0H31.1484C30.6016 0 30.1328 0.195312 29.7422 0.585938C29.3516 0.976562 29.1562 1.44531 29.1562 1.99219C29.1562 2.52344 29.3516 2.98438 29.7422 3.375C30.1328 3.76562 30.6016 3.96094 31.1484 3.96094H35.4375C36.7812 3.96094 37.8359 4.34375 38.6016 5.10938C39.3516 5.875 39.7266 6.92969 39.7266 8.27344V12.4688C39.7266 13 39.9219 13.4609 40.3125 13.8516C40.7031 14.2422 41.1719 14.4375 41.7188 14.4375C42.25 14.4375 42.7109 14.2422 43.1016 13.8516C43.4922 13.4609 43.6875 13 43.6875 12.4688ZM0 12.4688C0 13 0.195312 13.4609 0.585938 13.8516C0.976562 14.2422 1.4375 14.4375 1.96875 14.4375C2.5 14.4375 2.96094 14.2422 3.35156 13.8516C3.74219 13.4609 3.9375 13 3.9375 12.4688V8.27344C3.9375 6.92969 4.32031 5.875 5.08594 5.10938C5.83594 4.34375 6.89062 3.96094 8.25 3.96094H12.5391C13.0859 3.96094 13.5547 3.76562 13.9453 3.375C14.3203 2.98438 14.5078 2.52344 14.5078 1.99219C14.5078 1.44531 14.3203 0.976562 13.9453 0.585938C13.5547 0.195312 13.0859 0 12.5391 0H8.25C5.6875 0 3.67188 0.742188 2.20312 2.22656C0.734375 3.71094 0 5.72656 0 8.27344V12.4688ZM43.6875 31.2422C43.6875 30.7109 43.4922 30.25 43.1016 29.8594C42.7109 29.4688 42.25 29.2734 41.7188 29.2734C41.1719 29.2734 40.7031 29.4688 40.3125 29.8594C39.9219 30.25 39.7266 30.7109 39.7266 31.2422V35.4375C39.7266 36.7812 39.3516 37.8359 38.6016 38.6016C37.8359 39.3672 36.7812 39.75 35.4375 39.75H31.1484C30.6016 39.75 30.1328 39.9453 29.7422 40.3359C29.3516 40.7266 29.1562 41.1875 29.1562 41.7188C29.1562 42.2656 29.3516 42.7266 29.7422 43.1016C30.1328 43.4922 30.6016 43.6875 31.1484 43.6875H35.4375C38 43.6875 40.0156 42.9453 41.4844 41.4609C42.9531 39.9922 43.6875 37.9844 43.6875 35.4375V31.2422ZM0 31.2422V35.4375C0 37.9844 0.734375 39.9922 2.20312 41.4609C3.67188 42.9453 5.6875 43.6875 8.25 43.6875H12.5391C13.0859 43.6875 13.5547 43.4922 13.9453 43.1016C14.3203 42.7266 14.5078 42.2656 14.5078 41.7188C14.5078 41.1875 14.3203 40.7266 13.9453 40.3359C13.5547 39.9453 13.0859 39.75 12.5391 39.75H8.25C6.89062 39.75 5.83594 39.3672 5.08594 38.6016C4.32031 37.8359 3.9375 36.7812 3.9375 35.4375V31.2422C3.9375 30.7109 3.74219 30.25 3.35156 29.8594C2.96094 29.4688 2.5 29.2734 1.96875 29.2734C1.4375 29.2734 0.976562 29.4688 0.585938 29.8594C0.195312 30.25 0 30.7109 0 31.2422ZM31.5938 31.8047C32.7812 31.8047 33.6719 31.5156 34.2656 30.9375C34.8594 30.3438 35.1562 29.4688 35.1562 28.3125V16.7109C35.1562 15.5391 34.8594 14.6641 34.2656 14.0859C33.6719 13.4922 32.7812 13.1953 31.5938 13.1953H28.8984C28.4609 13.1953 28.1484 13.1406 27.9609 13.0312C27.7578 12.9219 27.5234 12.7266 27.2578 12.4453L26.3672 11.5078C26.0859 11.1953 25.7812 10.9688 25.4531 10.8281C25.1094 10.6719 24.6562 10.5938 24.0938 10.5938H19.6172C19.0547 10.5938 18.6094 10.6719 18.2812 10.8281C17.9375 10.9688 17.625 11.1953 17.3438 11.5078L16.4766 12.4453C16.2109 12.7422 15.9766 12.9453 15.7734 13.0547C15.5547 13.1484 15.2344 13.1953 14.8125 13.1953H12.0469C10.8906 13.1953 10.0156 13.4922 9.42188 14.0859C8.8125 14.6641 8.50781 15.5391 8.50781 16.7109V28.3125C8.50781 29.4688 8.8125 30.3438 9.42188 30.9375C10.0156 31.5156 10.8906 31.8047 12.0469 31.8047H31.5938ZM21.7969 28.9453C20.5938 28.9453 19.5 28.6641 18.5156 28.1016C17.5156 27.5234 16.7266 26.7422 16.1484 25.7578C15.5547 24.7578 15.2578 23.6328 15.2578 22.3828C15.2578 21.1797 15.5547 20.0859 16.1484 19.1016C16.7266 18.1016 17.5156 17.3125 18.5156 16.7344C19.5 16.1406 20.5938 15.8438 21.7969 15.8438C23.0156 15.8438 24.125 16.1406 25.125 16.7344C26.1094 17.3125 26.8984 18.1016 27.4922 19.1016C28.0703 20.0859 28.3594 21.1797 28.3594 22.3828C28.3594 23.6172 28.0703 24.7266 27.4922 25.7109C26.8984 26.6953 26.1094 27.4844 25.125 28.0781C24.125 28.6562 23.0156 28.9453 21.7969 28.9453ZM21.8203 26.9062C22.6484 26.9062 23.4062 26.7109 24.0938 26.3203C24.7812 25.9141 25.3281 25.3672 25.7344 24.6797C26.125 23.9922 26.3203 23.2266 26.3203 22.3828C26.3203 21.5703 26.125 20.8203 25.7344 20.1328C25.3281 19.4453 24.7812 18.9062 24.0938 18.5156C23.4062 18.1094 22.6484 17.9062 21.8203 17.9062C20.9922 17.9062 20.2422 18.1094 19.5703 18.5156C18.8828 18.9062 18.3359 19.4453 17.9297 20.1328C17.5234 20.8203 17.3203 21.5703 17.3203 22.3828C17.3203 23.2266 17.5234 23.9922 17.9297 24.6797C18.3359 25.3672 18.8828 25.9141 19.5703 26.3203C20.2422 26.7109 20.9922 26.9062 21.8203 26.9062ZM12.6328 18.9844C12.2109 18.9844 11.8594 18.8359 11.5781 18.5391C11.2812 18.2422 11.1328 17.8906 11.1328 17.4844C11.1328 17.0625 11.2812 16.7109 11.5781 16.4297C11.8594 16.1328 12.2109 15.9844 12.6328 15.9844C13.0391 15.9844 13.3906 16.1328 13.6875 16.4297C13.9844 16.7109 14.1328 17.0625 14.1328 17.4844C14.1328 17.8906 13.9844 18.2422 13.6875 18.5391C13.3906 18.8359 13.0391 18.9844 12.6328 18.9844Z"
    />
  </svg>
);

const RotateIcon = (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
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
