import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

type ExecFn = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

type Orientation = "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";

export interface SimulatorMenubarProps {
  exec: ExecFn;
  udid: string | null;
  /** Fire a hardware-button HID event. Names: home, lock, siri, app_switcher. */
  onButton: (button: string) => void;
  /** Rotate to the given orientation. */
  onRotate: (orientation: Orientation) => void;
  /** Toggle a CoreAnimation debug render flag via SimulatorBridge. */
  onCaDebug: (option: string, enabled: boolean) => void;
  /** Ask CoreSimulator to broadcast a memory warning to the guest. */
  onMemoryWarning: () => void;
  /** Capture a screenshot to the user's Desktop. */
  onScreenshot: () => void;
  style?: CSSProperties;
}

// Click a trigger to open its menu, click again or outside/Esc to close.
// Hovering another trigger while any menu is open switches to it (matches
// macOS menubar). Submenus open on hover with an 80 ms close delay so a
// diagonal pointer path to the submenu pane doesn't collapse it.

interface MenubarContextValue {
  openMenu: string | null;
  setOpenMenu: (next: string | null) => void;
  openSub: string | null;
  setOpenSub: (next: string | null) => void;
  closeAll: () => void;
}

const MenubarContext = createContext<MenubarContextValue | null>(null);

function useMenubar(): MenubarContextValue {
  const ctx = useContext(MenubarContext);
  if (!ctx) throw new Error("Menubar subcomponent rendered outside <Menubar>");
  return ctx;
}

export function SimulatorMenubar({
  exec,
  udid,
  onButton,
  onRotate,
  onCaDebug,
  onMemoryWarning,
  onScreenshot,
  style,
}: SimulatorMenubarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const closeAll = useCallback(() => {
    setOpenMenu(null);
    setOpenSub(null);
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeAll();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [openMenu, closeAll]);

  useEffect(() => {
    if (!openMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMenu, closeAll]);

  const runWithUdid = useCallback(
    (cmd: string) => {
      if (!udid) return;
      void exec(cmd.replace(/\$UDID/g, udid)).catch(() => {});
    },
    [exec, udid],
  );

  const [appearance, setAppearance] = useState<"light" | "dark">("light");
  const [enableReplays, setEnableReplays] = useState(false);
  const [showTouches, setShowTouches] = useState(false);
  const [showDeviceFrame, setShowDeviceFrame] = useState(true);

  const [slowAnimations, setSlowAnimations] = useState(false);
  const [colorBlended, setColorBlended] = useState(false);
  const [colorCopied, setColorCopied] = useState(false);
  const [colorMisaligned, setColorMisaligned] = useState(false);
  const [colorOffscreen, setColorOffscreen] = useState(false);

  const setAppearanceMode = useCallback(
    (value: "light" | "dark") => {
      setAppearance(value);
      runWithUdid(`xcrun simctl ui $UDID appearance ${value}`);
    },
    [runWithUdid],
  );

  const setLocation = useCallback(
    (lat: number, lng: number) => runWithUdid(`xcrun simctl location $UDID set ${lat},${lng}`),
    [runWithUdid],
  );

  const openDeepLink = useCallback(() => {
    const url = window.prompt("Open URL on simulator:", "https://");
    if (!url) return;
    const quoted = url.replace(/"/g, '\\"');
    runWithUdid(`xcrun simctl openurl $UDID "${quoted}"`);
  }, [runWithUdid]);

  const postDarwin = useCallback(
    (name: string) => {
      if (!udid) return;
      void exec(`xcrun simctl spawn ${udid} notifyutil -p ${name}`).catch(() => {});
    },
    [exec, udid],
  );

  const ctx: MenubarContextValue = { openMenu, setOpenMenu, openSub, setOpenSub, closeAll };

  return (
    <MenubarContext.Provider value={ctx}>
      <div ref={rootRef} style={{ ...rootStyle, ...style }}>
        <Menu name="device" label="Device">
          <Item onSelect={() => runWithUdid("xcrun simctl shutdown $UDID && xcrun simctl boot $UDID")}>Restart</Item>
          <Item
            onSelect={() => {
              if (!window.confirm("Erase all content and settings on this simulator?")) return;
              runWithUdid("xcrun simctl shutdown $UDID; xcrun simctl erase $UDID; xcrun simctl boot $UDID");
            }}
          >
            Erase All Content and Settings…
          </Item>
          <Separator />
          <Item shortcut="⌘←" onSelect={() => onRotate("landscape_left")}>Rotate Left</Item>
          <Item shortcut="⌘→" onSelect={() => onRotate("landscape_right")}>Rotate Right</Item>
          <Sub name="orientation" label="Orientation">
            <Item onSelect={() => onRotate("portrait")}>Portrait</Item>
            <Item onSelect={() => onRotate("landscape_left")}>Landscape Left</Item>
            <Item onSelect={() => onRotate("portrait_upside_down")}>Portrait Upside Down</Item>
            <Item onSelect={() => onRotate("landscape_right")}>Landscape Right</Item>
          </Sub>
          <Separator />
          <Item shortcut="⇧⌘H" onSelect={() => onButton("home")}>Home</Item>
          <Item shortcut="⌘L" onSelect={() => onButton("lock")}>Lock</Item>
          <Item shortcut="⌥⇧⌘H" onSelect={() => onButton("siri")}>Siri</Item>
          <Item shortcut="⌃⌘Z" onSelect={() => postDarwin("com.apple.UIKit.SimulatorShake")}>Shake</Item>
          <Item shortcut="⌃⇧⌘H" onSelect={() => onButton("app_switcher")}>App Switcher</Item>
          <Separator />
          <Item onSelect={onScreenshot}>Trigger Screenshot</Item>
          <Item onSelect={openDeepLink}>Open Deep Link…</Item>
        </Menu>

        <Menu name="features" label="Features">
          <Label>Device Appearance</Label>
          <RadioItem checked={appearance === "light"} onSelect={() => setAppearanceMode("light")}>Light</RadioItem>
          <RadioItem checked={appearance === "dark"} onSelect={() => setAppearanceMode("dark")}>Dark</RadioItem>
          <Separator />
          <Sub name="biometrics" label="Biometrics">
            <Item onSelect={() => runWithUdid("xcrun simctl spawn $UDID notifyutil -p com.apple.BiometricKit_Sim.enrollment.didChange")}>
              Toggle Enrolled State
            </Item>
            <Separator />
            <Item onSelect={() => runWithUdid("xcrun simctl spawn $UDID notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.match")}>
              Matching Touch ID
            </Item>
            <Item onSelect={() => runWithUdid("xcrun simctl spawn $UDID notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.nomatch")}>
              Non-Matching Touch ID
            </Item>
            <Separator />
            <Item onSelect={() => runWithUdid("xcrun simctl spawn $UDID notifyutil -p com.apple.BiometricKit_Sim.pearl.match")}>
              Matching Face ID
            </Item>
            <Item onSelect={() => runWithUdid("xcrun simctl spawn $UDID notifyutil -p com.apple.BiometricKit_Sim.pearl.nomatch")}>
              Non-Matching Face ID
            </Item>
          </Sub>
          <Sub name="location" label="Location">
            <Item onSelect={() => runWithUdid("xcrun simctl location $UDID clear")}>None</Item>
            <Separator />
            <Item onSelect={() => setLocation(37.334606, -122.009102)}>Apple</Item>
            <Item onSelect={() => setLocation(37.787359, -122.408227)}>City Run</Item>
            <Item onSelect={() => setLocation(37.331788, -121.891497)}>City Bicycle Ride</Item>
            <Item onSelect={() => setLocation(37.484693, -122.148296)}>Freeway Drive</Item>
            <Separator />
            <Item
              onSelect={() => {
                const input = window.prompt("Latitude,Longitude", "37.334606,-122.009102");
                if (!input) return;
                const [lat, lng] = input.split(",").map((s) => parseFloat(s.trim()));
                if (Number.isFinite(lat) && Number.isFinite(lng)) setLocation(lat!, lng!);
              }}
            >
              Custom Location…
            </Item>
          </Sub>
          <Sub name="localization" label="Localization">
            {[
              { code: "en", label: "English" },
              { code: "es", label: "Spanish" },
              { code: "fr", label: "French" },
              { code: "ja", label: "Japanese" },
            ].map((l) => (
              <Item
                key={l.code}
                onSelect={() => runWithUdid(`xcrun simctl spawn $UDID defaults write -g AppleLanguages -array ${l.code}`)}
              >
                {l.label}
              </Item>
            ))}
          </Sub>
          <Sub name="reset-perms" label="Reset Permissions">
            <Item onSelect={() => runWithUdid("xcrun simctl privacy $UDID reset all")}>All</Item>
            <Separator />
            {(["location", "contacts", "photos", "calendar", "microphone", "camera"] as const).map((perm) => (
              <Item key={perm} onSelect={() => runWithUdid(`xcrun simctl privacy $UDID reset ${perm}`)}>
                {perm[0]!.toUpperCase() + perm.slice(1)}
              </Item>
            ))}
          </Sub>
          <Item onSelect={openDeepLink}>Open Deep Link…</Item>
          <Separator />
          <CheckItem checked={enableReplays} onSelect={() => setEnableReplays((v) => !v)}>Enable Replays</CheckItem>
          <CheckItem checked={showTouches} onSelect={() => setShowTouches((v) => !v)}>Show Touches</CheckItem>
          <CheckItem checked={showDeviceFrame} onSelect={() => setShowDeviceFrame((v) => !v)}>Show Device Frame</CheckItem>
        </Menu>

        <Menu name="debug" label="Debug">
          <CheckItem
            checked={slowAnimations}
            onSelect={() => { const next = !slowAnimations; setSlowAnimations(next); onCaDebug("debug_slow_animations", next); }}
          >
            Slow Animations
          </CheckItem>
          <Separator />
          <CheckItem
            checked={colorBlended}
            onSelect={() => { const next = !colorBlended; setColorBlended(next); onCaDebug("debug_color_blended", next); }}
          >
            Color Blended Layers
          </CheckItem>
          <CheckItem
            checked={colorCopied}
            onSelect={() => { const next = !colorCopied; setColorCopied(next); onCaDebug("debug_color_copies", next); }}
          >
            Color Copied Images
          </CheckItem>
          <CheckItem
            checked={colorMisaligned}
            onSelect={() => { const next = !colorMisaligned; setColorMisaligned(next); onCaDebug("debug_color_misaligned", next); }}
          >
            Color Misaligned Images
          </CheckItem>
          <CheckItem
            checked={colorOffscreen}
            onSelect={() => { const next = !colorOffscreen; setColorOffscreen(next); onCaDebug("debug_color_offscreen", next); }}
          >
            Color Off-screen Rendered
          </CheckItem>
          <Separator />
          <Item shortcut="⌘/" onSelect={() => void exec("open -a Console")}>Open System Log…</Item>
          <Item shortcut="⇧⌘M" onSelect={onMemoryWarning}>Simulate Memory Warning</Item>
        </Menu>

        <Menu name="build" label="Build">
          <Sub name="grant-perms" label="Grant Permissions">
            {(["location", "camera", "microphone", "photos", "contacts", "calendar"] as const).map((perm) => (
              <Item key={perm} onSelect={() => runWithUdid(`xcrun simctl privacy $UDID grant ${perm}`)}>
                {perm[0]!.toUpperCase() + perm.slice(1)}
              </Item>
            ))}
          </Sub>
          <Item disabled>Revoke Permissions (PRO)</Item>
          <Item onSelect={() => runWithUdid("xcrun simctl privacy $UDID reset all")}>Reset Permissions</Item>
          <Separator />
          <Item
            onSelect={() => {
              const bundleId = window.prompt("Bundle identifier:", "");
              if (!bundleId) return;
              runWithUdid(`open "$(xcrun simctl get_app_container $UDID ${bundleId} app)"`);
            }}
          >
            Application Bundle (.app)
          </Item>
          <Item
            onSelect={() => {
              const bundleId = window.prompt("Bundle identifier:", "");
              if (!bundleId) return;
              runWithUdid(`open "$(xcrun simctl get_app_container $UDID ${bundleId} data)"`);
            }}
          >
            Sandbox User Data
          </Item>
        </Menu>
      </div>
    </MenubarContext.Provider>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────

function Menu({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  const ctx = useMenubar();
  const isOpen = ctx.openMenu === name;

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        style={{ ...triggerStyle, background: isOpen ? "rgba(99,102,241,0.45)" : "transparent" }}
        onClick={() => {
          if (isOpen) ctx.closeAll();
          else { ctx.setOpenMenu(name); ctx.setOpenSub(null); }
        }}
        onMouseEnter={() => {
          if (ctx.openMenu && ctx.openMenu !== name) {
            ctx.setOpenMenu(name);
            ctx.setOpenSub(null);
          }
        }}
      >
        {label}
      </button>
      {isOpen && <div style={contentStyle}>{children}</div>}
    </div>
  );
}

function Item({
  children,
  onSelect,
  shortcut,
  disabled,
  indicator,
}: {
  children: ReactNode;
  onSelect?: () => void;
  shortcut?: string;
  disabled?: boolean;
  indicator?: ReactNode;
}) {
  const ctx = useMenubar();
  const [hover, setHover] = useState(false);
  const bg = hover && !disabled ? "rgba(99,102,241,0.45)" : "transparent";
  return (
    <div
      role="menuitem"
      onClick={() => {
        if (disabled) return;
        onSelect?.();
        ctx.closeAll();
      }}
      onMouseEnter={() => {
        setHover(true);
        // Leaving a Sub means its submenu should close — entering a plain Item
        // of the parent menu clears openSub immediately.
        ctx.setOpenSub(null);
      }}
      onMouseLeave={() => setHover(false)}
      style={{
        ...itemStyle,
        background: bg,
        color: disabled ? "rgba(255,255,255,0.35)" : "#eee",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span style={indicatorSlotStyle}>{indicator}</span>
      <span style={{ flex: 1 }}>{children}</span>
      {shortcut && <span style={shortcutStyle}>{shortcut}</span>}
    </div>
  );
}

function CheckItem({ checked, children, onSelect }: { checked: boolean; onSelect: () => void; children: ReactNode }) {
  return <Item onSelect={onSelect} indicator={checked ? CheckIcon : null}>{children}</Item>;
}

function RadioItem({ checked, children, onSelect }: { checked: boolean; onSelect: () => void; children: ReactNode }) {
  return <Item onSelect={onSelect} indicator={checked ? DotIcon : null}>{children}</Item>;
}

function Separator() {
  return <div style={separatorStyle} />;
}

function Label({ children }: { children: ReactNode }) {
  return <div style={labelStyle}>{children}</div>;
}

// Submenu — hover to open, 120 ms grace period on leave so the pointer can
// cross the gap between trigger and panel without collapsing it.
function Sub({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  const ctx = useMenubar();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isOpen = ctx.openSub === name;

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (ctx.openSub === name) ctx.setOpenSub(null);
    }, 120);
  };

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => { cancelClose(); ctx.setOpenSub(name); }}
      onMouseLeave={scheduleClose}
    >
      <div
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        style={{
          ...itemStyle,
          background: isOpen ? "rgba(99,102,241,0.45)" : "transparent",
        }}
      >
        <span style={indicatorSlotStyle} />
        <span style={{ flex: 1 }}>{label}</span>
        <span style={shortcutStyle}>›</span>
      </div>
      {isOpen && (
        <div
          style={{
            ...contentStyle,
            position: "absolute",
            top: -4,
            left: "100%",
            marginLeft: 2,
          }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {children}
        </div>
      )}
    </div>
  );
}

const CheckIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const DotIcon = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <circle cx="5" cy="5" r="3" />
  </svg>
);

const rootStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: 3,
  background: "rgba(28,28,30,0.9)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  fontFamily: "-apple-system, system-ui, sans-serif",
  fontSize: 12,
  color: "#eee",
  backdropFilter: "blur(8px)",
  position: "relative",
  zIndex: 50,
};

const triggerStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#eee",
  padding: "4px 10px",
  borderRadius: 5,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: "inherit",
  outline: "none",
};

const contentStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  minWidth: 220,
  background: "#1c1c1e",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: 4,
  color: "#eee",
  fontFamily: "-apple-system, system-ui, sans-serif",
  fontSize: 13,
  boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
  zIndex: 40,
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px 6px 8px",
  borderRadius: 5,
  cursor: "pointer",
  userSelect: "none",
};

const separatorStyle: CSSProperties = {
  height: 1,
  background: "rgba(255,255,255,0.08)",
  margin: "4px 0",
};

const labelStyle: CSSProperties = {
  padding: "6px 10px 2px",
  fontSize: 10,
  fontWeight: 700,
  color: "rgba(255,255,255,0.45)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const shortcutStyle: CSSProperties = {
  color: "rgba(255,255,255,0.45)",
  fontSize: 11,
  marginLeft: 16,
  fontVariantNumeric: "tabular-nums",
};

const indicatorSlotStyle: CSSProperties = {
  width: 14,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#a5b4fc",
  flexShrink: 0,
};
