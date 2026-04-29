import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

type ExecFn = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

interface PanelsContextValue {
  exec: ExecFn;
  deviceUdid?: string | null;
  defaultBundleId?: string | null;
}

const PanelsContext = createContext<PanelsContextValue | null>(null);

function usePanels(component: string): PanelsContextValue {
  const ctx = useContext(PanelsContext);
  if (!ctx) {
    throw new Error(`<SimulatorPanels.${component}> must be rendered inside <SimulatorPanels>`);
  }
  return ctx;
}

export interface SimulatorPanelsProps {
  exec: ExecFn;
  deviceUdid?: string | null;
  /** Bundle id of the foreground app, used as the default target for actions (e.g. push). */
  defaultBundleId?: string | null;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  width: "100%",
  fontFamily: "-apple-system, system-ui, sans-serif",
};

function SimulatorPanelsRoot({
  exec,
  deviceUdid,
  defaultBundleId,
  children,
  style,
  className,
}: SimulatorPanelsProps) {
  const value = useMemo<PanelsContextValue>(
    () => ({ exec, deviceUdid, defaultBundleId }),
    [exec, deviceUdid, defaultBundleId],
  );
  return (
    <PanelsContext.Provider value={value}>
      <div className={className} style={{ ...containerStyle, ...style }}>
        {children}
      </div>
    </PanelsContext.Provider>
  );
}

// -- Generic collapsible panel ------------------------------------------

const panelStyle: CSSProperties = {
  background: "#1c1c1e",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 12,
  overflow: "hidden",
  color: "#eee",
};

const panelHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "10px 12px",
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 600,
};

const panelBodyStyle: CSSProperties = {
  padding: "0 12px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

interface PanelProps {
  title: ReactNode;
  icon?: ReactNode;
  defaultOpen?: boolean;
  children?: ReactNode;
}

function Panel({ title, icon, defaultOpen = false, children }: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={panelStyle}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={panelHeaderStyle}
      >
        {icon && <span style={{ display: "inline-flex", color: "rgba(255,255,255,0.7)" }}>{icon}</span>}
        <span style={{ flex: 1 }}>{title}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            color: "rgba(255,255,255,0.6)",
            transition: "transform 0.15s",
            transform: open ? "rotate(180deg)" : "rotate(0)",
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && <div style={panelBodyStyle}>{children}</div>}
    </div>
  );
}

// -- Push notification panel --------------------------------------------

const inputStyle: CSSProperties = {
  width: "100%",
  background: "#0a0a0a",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  padding: "6px 8px",
  color: "#eee",
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  outline: "none",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "rgba(255,255,255,0.5)",
};

const buttonStyle: CSSProperties = {
  background: "#a5b4fc",
  color: "#0a0a0a",
  border: "none",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};

const DEFAULT_PAYLOAD = JSON.stringify(
  {
    aps: {
      alert: { title: "Hello", body: "This is a test push notification" },
      sound: "default",
      badge: 1,
    },
  },
  null,
  2,
);

const PushIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

// Encode a JS string to base64 in a way that's safe for arbitrary unicode.
// btoa() rejects non-Latin-1, so encode as UTF-8 first.
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export interface PushNotificationPanelProps {
  /** Override the bundle id default; falls back to `defaultBundleId` from context. */
  defaultBundleId?: string | null;
  defaultOpen?: boolean;
}

function PushNotificationPanel({ defaultBundleId, defaultOpen }: PushNotificationPanelProps) {
  const { exec, deviceUdid, defaultBundleId: ctxDefault } = usePanels("PushNotification");
  const initialBundle = defaultBundleId ?? ctxDefault ?? "";
  const [bundleId, setBundleId] = useState(initialBundle);
  const [payload, setPayload] = useState(DEFAULT_PAYLOAD);
  const [status, setStatus] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  // Keep the input in sync if the foreground app changes while the panel is closed.
  useEffect(() => {
    setBundleId((current) => (current ? current : initialBundle));
  }, [initialBundle]);

  const send = useCallback(async () => {
    setStatus("sending");
    setMessage(null);

    if (!deviceUdid) {
      setStatus("error");
      setMessage("No simulator selected");
      return;
    }
    if (!bundleId.trim()) {
      setStatus("error");
      setMessage("Bundle id is required");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Invalid JSON");
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("aps" in (parsed as Record<string, unknown>))) {
      setStatus("error");
      setMessage("Payload must be a JSON object containing an 'aps' key");
      return;
    }

    const b64 = utf8ToBase64(JSON.stringify(parsed));
    const tmp = `/tmp/serve-sim-push-${crypto.randomUUID()}.apns`;
    const cmd =
      `bash -c 'echo ${b64} | base64 -d > ${tmp} && ` +
      `xcrun simctl push ${deviceUdid} ${bundleId.trim()} ${tmp}; ` +
      `rc=$?; rm -f ${tmp}; exit $rc'`;

    try {
      const res = await exec(cmd);
      if (res.exitCode !== 0) {
        setStatus("error");
        setMessage(res.stderr.trim() || `simctl push exited ${res.exitCode}`);
        return;
      }
      setStatus("ok");
      setMessage("Notification delivered");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to send notification");
    }
  }, [exec, deviceUdid, bundleId, payload]);

  const statusColor =
    status === "error" ? "#f87171" : status === "ok" ? "#4ade80" : "rgba(255,255,255,0.5)";

  return (
    <Panel title="Push notification" icon={PushIcon} defaultOpen={defaultOpen}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>Bundle id</span>
        <input
          type="text"
          value={bundleId}
          onChange={(e) => setBundleId(e.target.value)}
          placeholder="com.example.app"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={inputStyle}
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>APNs payload</span>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={8}
          spellCheck={false}
          style={{ ...inputStyle, resize: "vertical", minHeight: 120 }}
        />
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          onClick={() => void send()}
          disabled={status === "sending" || !deviceUdid}
          style={{
            ...buttonStyle,
            opacity: status === "sending" || !deviceUdid ? 0.5 : 1,
            cursor: status === "sending" || !deviceUdid ? "not-allowed" : "pointer",
          }}
        >
          {status === "sending" ? "Sending…" : "Send"}
        </button>
        {message && (
          <span style={{ fontSize: 11, color: statusColor, flex: 1 }}>{message}</span>
        )}
      </div>
    </Panel>
  );
}

type SimulatorPanelsCompound = typeof SimulatorPanelsRoot & {
  Panel: typeof Panel;
  PushNotification: typeof PushNotificationPanel;
};

export const SimulatorPanels = SimulatorPanelsRoot as SimulatorPanelsCompound;
SimulatorPanels.Panel = Panel;
SimulatorPanels.PushNotification = PushNotificationPanel;

export { PushNotificationPanel };
