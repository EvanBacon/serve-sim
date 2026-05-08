import { createRoot } from "react-dom/client";
import { AX_UNAVAILABLE_ERROR } from "../ax-shared";
import type { AxElement, AxRect, AxSnapshot } from "../ax-shared";
import { groupTargetsByApp } from "../devtools-targets";
import {
  createContext,
  memo,
  useEffect,
  useState,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  SimulatorView,
  displayStreamConfig,
  fallbackScreenSize,
  screenBorderRadius,
  SimulatorToolbar,
  getDeviceType,
  simulatorAspectRatio,
  simulatorMaxWidth,
  type DeviceType,
  type SimulatorOrientation,
  type StreamConfig,
} from "serve-sim-client/simulator";

/**
 * Fetches an MJPEG stream and parses out individual JPEG frames as blob URLs.
 * Chrome doesn't support multipart/x-mixed-replace in <img> tags,
 * so we manually read the stream and extract JPEG boundaries.
 */
function useMjpegStream(streamUrl: string | null) {
  const [config, setConfig] = useState<StreamConfig | null>(null);
  const subscribersRef = useRef<Set<(blobUrl: string) => void>>(new Set());

  const subscribeFrame = useCallback(
    (cb: (blobUrl: string) => void) => {
      subscribersRef.current.add(cb);
      return () => { subscribersRef.current.delete(cb); };
    },
    [],
  );

  useEffect(() => {
    if (!streamUrl) return;
    const controller = new AbortController();
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Poll config for screen dimensions + requested orientation.
    const baseUrl = streamUrl.replace(/\/stream\.mjpeg$/, "");
    const applyConfig = (c: StreamConfig) => {
      if (c.width <= 0 || c.height <= 0) return;
      setConfig((prev) =>
        prev &&
        prev.width === c.width &&
        prev.height === c.height &&
        prev.orientation === c.orientation
          ? prev
          : c,
      );
    };
    const fetchConfig = () => {
      fetch(`${baseUrl}/config`, { signal: controller.signal })
        .then((r) => r.json())
        .then(applyConfig)
        .catch(() => {});
    };
    fetchConfig();
    const configInterval = setInterval(fetchConfig, 1000);

    // Read the MJPEG stream and extract JPEG frames.
    // ?raw=1 tells the server to use Content-Type application/octet-stream
    // instead of multipart/x-mixed-replace; WebKit refuses to expose
    // multipart bodies to fetch()'s ReadableStream.
    const fetchUrlObj = new URL(streamUrl);
    fetchUrlObj.searchParams.set("raw", "1");
    const fetchUrl = fetchUrlObj.toString();
    const scheduleRetry = () => {
      if (stopped || controller.signal.aborted || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void readStream();
      }, 1000);
    };
    const readStream = async () => {
      try {
        const res = await fetch(fetchUrl, { signal: controller.signal });
        const reader = res.body?.getReader();
        if (!reader) {
          scheduleRetry();
          return;
        }

        let buffer = new Uint8Array(0);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Append new data
          const newBuf = new Uint8Array(buffer.length + value.length);
          newBuf.set(buffer);
          newBuf.set(value, buffer.length);
          buffer = newBuf;

          // Look for JPEG frames: find Content-Length or JPEG markers (FFD8...FFD9)
          // Simpler approach: split on boundary markers and extract JPEG data
          while (true) {
            // Find first JPEG start (FF D8)
            let jpegStart = -1;
            for (let i = 0; i < buffer.length - 1; i++) {
              if (buffer[i] === 0xff && buffer[i + 1] === 0xd8) {
                jpegStart = i;
                break;
              }
            }
            if (jpegStart === -1) break;

            // Find JPEG end (FF D9) after the start
            let jpegEnd = -1;
            for (let i = jpegStart + 2; i < buffer.length - 1; i++) {
              if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) {
                jpegEnd = i + 2;
                break;
              }
            }
            if (jpegEnd === -1) break;

            // Extract the JPEG frame
            const jpeg = buffer.slice(jpegStart, jpegEnd);
            buffer = buffer.slice(jpegEnd);

            const blob = new Blob([jpeg], { type: "image/jpeg" });
            const blobUrl = URL.createObjectURL(blob);
            if (subscribersRef.current.size === 0) {
              URL.revokeObjectURL(blobUrl);
              continue;
            }
            for (const cb of subscribersRef.current) {
              cb(blobUrl);
            }
          }
        }
      } catch {
        // Aborted or network error
      } finally {
        scheduleRetry();
      }
    };
    void readStream();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
      clearInterval(configInterval);
    };
  }, [streamUrl]);

  return { subscribeFrame, frame: null, config };
}


// ─── HID keyboard mapping ───

// Browser KeyboardEvent.code → USB HID Usage Page 0x07 keyboard usage code.
// See https://usb.org/sites/default/files/hut1_5.pdf §10 (Keyboard/Keypad Page).
const HID_USAGE_BY_CODE: Record<string, number> = {
  KeyA: 0x04, KeyB: 0x05, KeyC: 0x06, KeyD: 0x07, KeyE: 0x08, KeyF: 0x09,
  KeyG: 0x0a, KeyH: 0x0b, KeyI: 0x0c, KeyJ: 0x0d, KeyK: 0x0e, KeyL: 0x0f,
  KeyM: 0x10, KeyN: 0x11, KeyO: 0x12, KeyP: 0x13, KeyQ: 0x14, KeyR: 0x15,
  KeyS: 0x16, KeyT: 0x17, KeyU: 0x18, KeyV: 0x19, KeyW: 0x1a, KeyX: 0x1b,
  KeyY: 0x1c, KeyZ: 0x1d,
  Digit1: 0x1e, Digit2: 0x1f, Digit3: 0x20, Digit4: 0x21, Digit5: 0x22,
  Digit6: 0x23, Digit7: 0x24, Digit8: 0x25, Digit9: 0x26, Digit0: 0x27,
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30,
  Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
  Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
  F1: 0x3a, F2: 0x3b, F3: 0x3c, F4: 0x3d, F5: 0x3e, F6: 0x3f,
  F7: 0x40, F8: 0x41, F9: 0x42, F10: 0x43, F11: 0x44, F12: 0x45,
  PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49,
  Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
  NumLock: 0x53,
  NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56,
  NumpadAdd: 0x57, NumpadEnter: 0x58,
  Numpad1: 0x59, Numpad2: 0x5a, Numpad3: 0x5b, Numpad4: 0x5c,
  Numpad5: 0x5d, Numpad6: 0x5e, Numpad7: 0x5f, Numpad8: 0x60,
  Numpad9: 0x61, Numpad0: 0x62, NumpadDecimal: 0x63,
  ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
  ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
};

function hidUsageForCode(code: string): number | null {
  return HID_USAGE_BY_CODE[code] ?? null;
}

// ─── Types ───

declare global {
  interface Window {
    __SIM_PREVIEW__?: {
      url: string;
      streamUrl: string;
      wsUrl: string;
      port: number;
      device: string;
      basePath: string;
      logsEndpoint?: string;
      axEndpoint?: string;
      appStateEndpoint?: string;
      devtoolsEndpoint?: string;
    };
  }
}

function simEndpoint(path: string): string {
  const basePath = window.__SIM_PREVIEW__?.basePath ?? "/";
  return basePath === "/" ? `/${path}` : `${basePath}/${path}`;
}

function isAxeUnavailable(snapshot: AxSnapshot | null) {
  return snapshot?.errors?.includes(AX_UNAVAILABLE_ERROR) ?? false;
}

function ReloadIcon({ size = 18, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function useAxSnapshot(endpoint?: string) {
  const [snapshot, setSnapshot] = useState<AxSnapshot | null>(null);
  const [status, setStatus] = useState("AX off");

  useEffect(() => {
    if (!endpoint) {
      setSnapshot(null);
      setStatus("AX off");
      return;
    }

    setSnapshot(null);
    setStatus("AX waiting");
    const source = new EventSource(endpoint);
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as AxSnapshot;
        setSnapshot(next);
        setStatus(
          isAxeUnavailable(next)
            ? "AX unavailable"
            : `${next.elements.length} AX elements`,
        );
      } catch {
        setStatus("AX parse error");
      }
    };
    source.addEventListener("error", () => {
      setStatus("AX reconnecting");
    });
    return () => source.close();
  }, [endpoint]);

  return { snapshot, status };
}

interface AxSnapshotContextValue {
  snapshot: AxSnapshot | null;
  status: string;
}

interface AxSelectionContextValue {
  highlightedKey: string | null;
  selectedKey: string | null;
  setHighlightedKey: (key: string | null) => void;
  setSelectedKey: (key: string | null) => void;
}

const AxSnapshotContext = createContext<AxSnapshotContextValue>({
  snapshot: null,
  status: "AX off",
});
const AxSelectionContext = createContext<AxSelectionContextValue | null>(null);

function useAxSnapshotContext() {
  return useContext(AxSnapshotContext);
}

function useAxSelectionContext() {
  const context = useContext(AxSelectionContext);
  if (!context) throw new Error("AX selection context is unavailable");
  return context;
}

function AxStateProvider({
  endpoint,
  children,
}: {
  endpoint?: string;
  children: ReactNode;
}) {
  const { snapshot, status } = useAxSnapshot(endpoint);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!endpoint) {
      setHighlightedKey(null);
      setSelectedKey(null);
    }
  }, [endpoint]);

  const snapshotValue = useMemo(
    () => ({ snapshot, status }),
    [snapshot, status],
  );
  const selectionValue = useMemo(
    () => ({
      highlightedKey,
      selectedKey,
      setHighlightedKey,
      setSelectedKey,
    }),
    [highlightedKey, selectedKey],
  );

  return (
    <AxSnapshotContext.Provider value={snapshotValue}>
      <AxSelectionContext.Provider value={selectionValue}>
        {children}
      </AxSelectionContext.Provider>
    </AxSnapshotContext.Provider>
  );
}

// ─── Exec / devices ───

interface ExecResult { stdout: string; stderr: string; exitCode: number }

interface WebKitDevtoolsTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  appName?: string;
  bundleId?: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl: string;
  inUseByOtherInspector?: boolean;
}

interface WebKitDevtoolsResponse {
  port: number;
  targets: WebKitDevtoolsTarget[];
  error?: string;
}

async function execOnHost(command: string): Promise<ExecResult> {
  const res = await fetch(simEndpoint("exec"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  return res.json();
}

function useWebKitDevtools(endpoint: string | undefined, enabled: boolean) {
  const [targets, setTargets] = useState<WebKitDevtoolsTarget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!endpoint) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { cache: "no-store" });
      const json = (await res.json()) as WebKitDevtoolsResponse;
      if (!res.ok || json.error) throw new Error(json.error || "Failed to list WebKit targets");
      setTargets(json.targets ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start WebKit DevTools");
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  return { targets, error, loading, refresh };
}

// WebKit doesn't supply a screencast feed, so the embedded Chrome DevTools'
// screencast pane is dead space. Click the "Toggle screencast" toolbar button
// once the iframe loads to collapse it. The button lives inside DevTools'
// shadow DOM, so we walk shadow roots to find it.
function collapseScreencastPane(iframe: HTMLIFrameElement) {
  const root = iframe.contentDocument;
  if (!root) return;
  const find = (): HTMLElement | null => {
    const stack: ParentNode[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      const candidates = node.querySelectorAll<HTMLElement>("[aria-label],[title]");
      for (const el of candidates) {
        const label = el.getAttribute("aria-label") || el.title || "";
        if (/^toggle screencast$/i.test(label)) return el;
      }
      for (const el of node.querySelectorAll<HTMLElement>("*")) {
        if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
    return null;
  };
  let attempts = 0;
  const tick = () => {
    attempts++;
    const btn = find();
    if (btn && btn.getAttribute("aria-pressed") !== "false") {
      btn.click();
      return;
    }
    if (attempts < 20) setTimeout(tick, 100);
  };
  tick();
}


// Process-wide icon cache — keyed by udid:bundleId so a switch between
// devices doesn't reuse stale art. Values are pending fetches OR resolved
// data URLs (or null when no icon could be located).
const appIconCache = new Map<string, Promise<string | null> | string | null>();

function fetchAppIcon(udid: string, bundleId: string): Promise<string | null> {
  const key = `${udid}:${bundleId}`;
  const existing = appIconCache.get(key);
  if (existing !== undefined) {
    return Promise.resolve(existing as string | null | Promise<string | null>);
  }
  const pending = fetchAppDetails(execOnHost, udid, bundleId).then((d) => {
    const url = d.iconDataUrl ?? null;
    appIconCache.set(key, url);
    return url;
  }).catch(() => {
    appIconCache.set(key, null);
    return null;
  });
  appIconCache.set(key, pending);
  return pending;
}

function useAppIcons(udid: string | null | undefined, bundleIds: string[]) {
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  // Stable key so the effect re-runs only when the *set* of bundle ids changes.
  // Memoize so the sort doesn't run on every render.
  const sig = useMemo(() => bundleIds.slice().sort().join("|"), [bundleIds]);
  useEffect(() => {
    if (!udid) return;
    let cancelled = false;
    for (const bundleId of bundleIds) {
      if (!bundleId) continue;
      const cacheKey = `${udid}:${bundleId}`;
      const cached = appIconCache.get(cacheKey);
      if (typeof cached === "string" || cached === null) {
        setIcons((prev) => (prev[bundleId] === cached ? prev : { ...prev, [bundleId]: cached as string | null }));
        continue;
      }
      void fetchAppIcon(udid, bundleId).then((url) => {
        if (cancelled) return;
        setIcons((prev) => ({ ...prev, [bundleId]: url }));
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [udid, sig]);
  return icons;
}

// Fire-and-forget highlight nudge — mirrors Safari's Develop menu hover. The
// caller doesn't await so cursor latency stays at zero; failures are silent.
function postHighlightTarget(targetId: string, on: boolean) {
  void fetch(simEndpoint("devtools/highlight"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId, on }),
    keepalive: true,
  }).catch(() => {});
}

// Tell the bridge to drop any cached hover sessions for this picker. Called
// on close / unmount / pagehide so we don't camp on a WIR slot the user no
// longer cares about. `sendBeacon` survives pagehide where `fetch` may not.
function postReleaseHighlights() {
  const url = simEndpoint("devtools/release");
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const blob = new Blob(["{}"], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    }
  } catch {}
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    keepalive: true,
  }).catch(() => {});
}

function WebKitTargetPicker({
  udid,
  targets,
  selected,
  onSelectTarget,
  onRefresh,
}: {
  udid: string;
  targets: WebKitDevtoolsTarget[];
  selected: WebKitDevtoolsTarget | null;
  onSelectTarget: (id: string) => void;
  onRefresh: () => void;
}) {
  const groups = groupTargetsByApp(targets);
  const bundleIds = groups.map((g) => g.bundleId).filter((id): id is string => !!id);
  const icons = useAppIcons(udid, bundleIds);
  const [open, setOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Clicking outside closes the popover. Listening on document captures
  // strays without forcing every row to swallow events.
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Cancel any lingering highlight when the popover closes (or unmounts).
  // Also drop the underlying CDP sessions: hovering opens a debugger socket
  // per target, and a hovered-but-never-selected page would otherwise stay
  // on the WIR slot until the idle timer fires.
  useEffect(() => {
    if (open) return;
    if (hoveredRef.current) {
      postHighlightTarget(hoveredRef.current, false);
      hoveredRef.current = null;
    }
    postReleaseHighlights();
  }, [open]);

  // Best-effort cleanup if the page itself goes away (tab close, navigation).
  useEffect(() => {
    const onLeave = () => postReleaseHighlights();
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, []);

  const label = selected
    ? (selected.title || selected.url || selected.appName || "Untitled").slice(0, 90)
    : "Select target";

  return (
    <div ref={containerRef} style={devtoolsStyles.pickerWrap}>
      <button
        type="button"
        onClick={() => {
          setOpen((wasOpen) => {
            // Revalidate the listing when the popover is about to open. The
            // bridge polls in the background, but a fresh request makes sure
            // newly-launched (or just-closed) pages show up immediately.
            if (!wasOpen) onRefresh();
            return !wasOpen;
          });
        }}
        style={devtoolsStyles.pickerButton}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="WebKit target"
      >
        <span style={devtoolsStyles.pickerLabel}>{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <ul role="listbox" style={devtoolsStyles.pickerList}>
          {groups.map((group) => {
            const iconUrl = group.bundleId ? icons[group.bundleId] : null;
            return (
            <li key={group.key} style={devtoolsStyles.pickerGroup}>
              <div style={devtoolsStyles.pickerGroupHeader}>
                {iconUrl ? (
                  <img src={iconUrl} alt="" style={devtoolsStyles.pickerGroupIconImg} />
                ) : (
                  <span style={devtoolsStyles.pickerGroupIconImg} aria-hidden="true" />
                )}
                <span style={devtoolsStyles.pickerGroupName}>{group.appName}</span>
              </div>
              <ul role="group" style={devtoolsStyles.pickerGroupList}>
                {group.targets.map((target) => {
                  const isSelected = selected?.id === target.id;
                  const isDisabled = !!target.inUseByOtherInspector && !isSelected;
                  const title = (target.title || target.url || target.appName || "Untitled").slice(0, 90);
                  return (
                    <li
                      key={target.id}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={isDisabled}
                      tabIndex={isDisabled ? -1 : 0}
                      title={isDisabled ? "Already being inspected by another debugger" : undefined}
                      onMouseEnter={() => {
                        if (isDisabled) return;
                        if (hoveredRef.current && hoveredRef.current !== target.id) {
                          postHighlightTarget(hoveredRef.current, false);
                        }
                        hoveredRef.current = target.id;
                        setHoveredId(target.id);
                        postHighlightTarget(target.id, true);
                      }}
                      onMouseLeave={() => {
                        if (hoveredRef.current === target.id) {
                          postHighlightTarget(target.id, false);
                          hoveredRef.current = null;
                        }
                        setHoveredId((prev) => (prev === target.id ? null : prev));
                      }}
                      onClick={() => {
                        if (isDisabled) return;
                        onSelectTarget(target.id);
                        setOpen(false);
                      }}
                      style={{
                        ...devtoolsStyles.pickerItem,
                        ...(isSelected ? devtoolsStyles.pickerItemSelected : null),
                        ...(hoveredId === target.id && !isDisabled ? devtoolsStyles.pickerItemHovered : null),
                        ...(isDisabled ? devtoolsStyles.pickerItemDisabled : null),
                      }}
                    >
                      <span style={devtoolsStyles.pickerItemTitle}>{title}</span>
                      {target.url && target.url !== "about:blank" && (
                        <span style={devtoolsStyles.pickerItemUrl}>{target.url}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

function parseSimctlList(stdout: string): SimDevice[] {
  try {
    const parsed = JSON.parse(stdout);
    const out: SimDevice[] = [];
    for (const [runtime, devs] of Object.entries<any[]>(parsed.devices ?? {})) {
      const runtimeName = runtime
        .replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "")
        .replace(/-/g, ".");
      for (const d of devs) {
        if (d.isAvailable) {
          out.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtimeName });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function deviceKind(name: string): number {
  const n = name.toLowerCase();
  if (n.includes("iphone")) return 0;
  if (n.includes("ipad")) return 1;
  if (n.includes("watch")) return 2;
  if (n.includes("vision")) return 3;
  return 4;
}

function runtimeOrder(runtime: string): number {
  const r = runtime.toLowerCase();
  if (r.startsWith("ios")) return 0;
  if (r.startsWith("ipados")) return 1;
  if (r.startsWith("watchos")) return 2;
  if (r.startsWith("visionos") || r.startsWith("xros")) return 3;
  return 4;
}

// ─── Device picker ───
//
// Inline dropdown — no shadcn / hugeicons dependency so the serve-sim client
// stays self-contained.

function DevicePicker({
  devices,
  selectedUdid,
  loading,
  error,
  stoppingUdids,
  onRefresh,
  onSelect,
  onStop,
  trigger,
}: {
  devices: SimDevice[];
  selectedUdid: string | null;
  loading: boolean;
  error: string | null;
  stoppingUdids: Set<string>;
  onRefresh: () => void;
  onSelect: (d: SimDevice) => void;
  onStop: (udid: string) => void;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const grouped = new Map<string, SimDevice[]>();
  for (const d of devices) {
    if (d.udid === selectedUdid) continue;
    let list = grouped.get(d.runtime);
    if (!list) { list = []; grouped.set(d.runtime, list); }
    list.push(d);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => deviceKind(a.name) - deviceKind(b.name) || a.name.localeCompare(b.name));
  }
  const sortedGroups = [...grouped.entries()].sort(
    ([a], [b]) => runtimeOrder(a) - runtimeOrder(b) || a.localeCompare(b),
  );
  const selected = devices.find((d) => d.udid === selectedUdid) ?? null;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <div
        onClick={() => {
          if (!open) onRefresh();
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </div>
      {open && (
        <div style={pickerMenuStyle}>
          <div style={pickerHeaderStyle}>
            <span style={{ fontWeight: 600 }}>Simulators</span>
            <button
              onClick={(e) => { e.stopPropagation(); onRefresh(); }}
              disabled={loading}
              style={pickerRefreshStyle}
            >
              {loading ? "..." : "Refresh"}
            </button>
          </div>
          {error && <div style={pickerErrorStyle}>{error}</div>}
          {selected && (
            <>
              <div style={{ ...pickerItemStyle, color: "#a5b4fc" }}>
                <span style={dotStyle(selected.state === "Booted" ? "#4ade80" : "#444")} />
                <span style={{ flex: 1 }}>{selected.name}</span>
              </div>
              <div style={pickerSeparatorStyle} />
            </>
          )}
          {devices.length === 0 && !loading && !error && (
            <div style={pickerEmptyStyle}>No available simulators found</div>
          )}
          {sortedGroups.map(([runtime, devs]) => (
            <div key={runtime}>
              <div style={pickerGroupHeaderStyle}>{runtime}</div>
              {devs.map((d) => {
                const isStopping = stoppingUdids.has(d.udid);
                const isBooted = d.state === "Booted";
                return (
                  <div
                    key={d.udid}
                    style={pickerItemStyle}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    onClick={() => { onSelect(d); setOpen(false); }}
                  >
                    <span style={dotStyle(isBooted ? "#4ade80" : "#444")} />
                    <span style={{ flex: 1 }}>{d.name}</span>
                    {isBooted && (
                      <span
                        role="button"
                        onClick={(e) => { e.stopPropagation(); if (!isStopping) onStop(d.udid); }}
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          color: isStopping ? "#888" : "#f87171",
                          background: isStopping ? "transparent" : "rgba(248,113,113,0.1)",
                          cursor: isStopping ? "default" : "pointer",
                        }}
                      >
                        {isStopping ? "Stopping..." : "Stop"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function dotStyle(color: string): CSSProperties {
  return { width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 };
}

// ─── File drop (drag media/ipa onto the simulator) ───
//
// Media → `xcrun simctl addmedia`   (Photos)
// .ipa  → `xcrun simctl install`    (install app on simulator)
//
// Files are streamed to /tmp over /exec in base64-chunked bash `echo | base64 -d`
// calls. No sonner dep here, so uploads surface in an inline toast list.

const DROP_MEDIA_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

// 256KB per chunk. macOS ARG_MAX is 1MB, so this leaves generous headroom
// for the bash/echo wrapper while sharply cutting round-trips on large .ipa
// uploads (100MB → ~400 calls instead of ~3200 at 32KB).
const DROP_CHUNK_SIZE = 262144;
const DROP_MAX_FILE_SIZE = 500 * 1024 * 1024;

type DropKind = "media" | "ipa";

function dropKindFor(file: File): DropKind | null {
  if (fileExtension(file) === "ipa") return "ipa";
  if (DROP_MEDIA_MIME_TYPES.has(file.type)) return "media";
  return null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fileExtension(file: File): string {
  const name = file.name;
  const dot = name.lastIndexOf(".");
  if (dot >= 0) return name.slice(dot + 1).toLowerCase();
  if (file.type.startsWith("video/")) return "mp4";
  return "jpg";
}

async function uploadDroppedFile(
  file: File,
  kind: DropKind,
  exec: (command: string) => Promise<ExecResult>,
  udid: string,
) {
  if (file.size > DROP_MAX_FILE_SIZE) {
    throw new Error("File too large (max 500MB)");
  }

  const ext = kind === "ipa" ? "ipa" : fileExtension(file);
  const prefix = kind === "ipa" ? "serve-sim-install" : "serve-sim-upload";
  const tmpPath = `/tmp/${prefix}-${crypto.randomUUID()}.${ext}`;

  try {
    const buffer = await file.arrayBuffer();
    const b64 = arrayBufferToBase64(buffer);

    for (let offset = 0; offset < b64.length; offset += DROP_CHUNK_SIZE) {
      const chunk = b64.slice(offset, offset + DROP_CHUNK_SIZE);
      const op = offset === 0 ? ">" : ">>";
      const result = await exec(`bash -c 'echo ${chunk} | base64 -d ${op} ${tmpPath}'`);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Write failed (exit ${result.exitCode})`);
      }
    }

    const cmd = kind === "ipa"
      ? `xcrun simctl install ${udid} ${tmpPath}`
      : `xcrun simctl addmedia ${udid} ${tmpPath}`;
    const result = await exec(cmd);
    if (result.exitCode !== 0) {
      const label = kind === "ipa" ? "install" : "addmedia";
      throw new Error(result.stderr || `${label} failed (exit ${result.exitCode})`);
    }
  } finally {
    exec(`bash -c 'rm -f ${tmpPath}'`).catch(() => {});
  }
}

type UploadToast = {
  id: string;
  name: string;
  kind: DropKind;
  status: "uploading" | "success" | "error";
  message?: string;
};

function useUploadToasts() {
  const [toasts, setToasts] = useState<UploadToast[]>([]);
  const add = useCallback((name: string, kind: DropKind): string => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, name, kind, status: "uploading" }]);
    return id;
  }, []);
  const update = useCallback((id: string, patch: Partial<UploadToast>) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    // Auto-dismiss finished toasts after 3s.
    if (patch.status === "success" || patch.status === "error") {
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, 3000);
    }
  }, []);
  return { toasts, add, update };
}

function useMediaDrop({
  exec,
  udid,
  enabled,
  onUploadStart,
  onUploadEnd,
  onUnsupported,
}: {
  exec: (command: string) => Promise<ExecResult>;
  udid: string | undefined;
  enabled: boolean;
  onUploadStart: (name: string, kind: DropKind) => string;
  onUploadEnd: (id: string, ok: boolean, message?: string) => void;
  onUnsupported: (file: File) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCountRef = useRef(0);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current = 0;
      setIsDragOver(false);

      if (!enabled || !udid) return;

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      for (const file of files) {
        const kind = dropKindFor(file);
        if (!kind) {
          onUnsupported(file);
          continue;
        }
        const id = onUploadStart(file.name, kind);
        uploadDroppedFile(file, kind, exec, udid)
          .then(() => onUploadEnd(id, true))
          .catch((err) =>
            onUploadEnd(id, false, err instanceof Error ? err.message : "Upload failed"),
          );
      }
    },
    [enabled, udid, exec, onUploadStart, onUploadEnd, onUnsupported],
  );

  const onDragOver = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (enabled) e.dataTransfer.dropEffect = "copy";
    },
    [enabled],
  );

  const onDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (!enabled) return;
      dragCountRef.current++;
      if (dragCountRef.current === 1) setIsDragOver(true);
    },
    [enabled],
  );

  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  return {
    isDragOver,
    dropZoneProps: { onDragOver, onDragEnter, onDragLeave, onDrop: handleDrop },
  };
}

// ─── Side panel (tools) ───

interface AppDetails {
  bundleId: string;
  isReactNative: boolean;
  pid?: number;
  displayName?: string;
  shortVersion?: string;
  bundleVersion?: string;
  minOS?: string;
  executable?: string;
  appPath?: string;
  iconDataUrl?: string | null;
  loading: boolean;
  error?: string;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function fetchAppDetails(
  exec: (cmd: string) => Promise<ExecResult>,
  udid: string,
  bundleId: string,
): Promise<Partial<AppDetails>> {
  const ctn = await exec(`xcrun simctl get_app_container ${udid} ${shellEscape(bundleId)} app`);
  if (ctn.exitCode !== 0) {
    return { error: ctn.stderr.trim() || "App not found on simulator" };
  }
  const appPath = ctn.stdout.trim();
  if (!appPath) return { error: "Empty app path" };

  // Read Info.plist as JSON. plutil -convert json -o - is available on macOS.
  const plist = await exec(`plutil -convert json -o - ${shellEscape(appPath + "/Info.plist")}`);
  let info: any = {};
  if (plist.exitCode === 0) {
    try { info = JSON.parse(plist.stdout); } catch {}
  }

  // Try to find app icon. CFBundleIcons → primary → CFBundleIconFiles last entry,
  // fall back to CFBundleIconFiles / CFBundleIconFile.
  let iconName: string | undefined;
  const primary = info?.CFBundleIcons?.CFBundlePrimaryIcon
    ?? info?.["CFBundleIcons~ipad"]?.CFBundlePrimaryIcon;
  const iconFiles: string[] | undefined = primary?.CFBundleIconFiles ?? info?.CFBundleIconFiles;
  if (iconFiles && iconFiles.length > 0) iconName = iconFiles[iconFiles.length - 1];
  else if (typeof info?.CFBundleIconFile === "string") iconName = info.CFBundleIconFile;

  let iconDataUrl: string | null = null;
  if (iconName) {
    // Icons are commonly compiled into Assets.car; loose PNGs may exist as
    // <icon>@2x.png / @3x.png. Try a handful of candidates.
    const candidates = [
      `${iconName}@3x.png`,
      `${iconName}@2x.png`,
      `${iconName}.png`,
      `${iconName}60x60@3x.png`,
      `${iconName}60x60@2x.png`,
    ];
    const find = await exec(
      `bash -c ${shellEscape(
        candidates.map((c) => `[ -f ${shellEscape(appPath + "/" + c)} ] && echo ${shellEscape(appPath + "/" + c)} && exit 0`).join("; ") + "; exit 1",
      )}`,
    );
    const iconPath = find.stdout.trim();
    if (iconPath) {
      const b64 = await exec(`base64 -i ${shellEscape(iconPath)}`);
      if (b64.exitCode === 0) {
        iconDataUrl = `data:image/png;base64,${b64.stdout.replace(/\s+/g, "")}`;
      }
    }
  }

  return {
    appPath,
    displayName: info.CFBundleDisplayName ?? info.CFBundleName,
    shortVersion: info.CFBundleShortVersionString,
    bundleVersion: info.CFBundleVersion,
    minOS: info.MinimumOSVersion,
    executable: info.CFBundleExecutable,
    iconDataUrl,
  };
}

function AppDetectionTool({
  udid,
  currentApp,
}: {
  udid: string;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
}) {
  const [details, setDetails] = useState<AppDetails | null>(null);

  useEffect(() => {
    if (!currentApp) { setDetails(null); return; }
    let cancelled = false;
    setDetails({
      bundleId: currentApp.bundleId,
      isReactNative: currentApp.isReactNative,
      pid: currentApp.pid,
      loading: true,
    });
    fetchAppDetails(execOnHost, udid, currentApp.bundleId).then((extra) => {
      if (cancelled) return;
      setDetails({
        bundleId: currentApp.bundleId,
        isReactNative: currentApp.isReactNative,
        pid: currentApp.pid,
        loading: false,
        ...extra,
      });
    });
    return () => { cancelled = true; };
  }, [udid, currentApp?.bundleId, currentApp?.pid, currentApp?.isReactNative]);

  if (!details) {
    return (
      <div style={panelStyles.empty}>
        Waiting for an app to come to the foreground…
      </div>
    );
  }

  return (
    <div style={panelStyles.section}>
      <div style={panelStyles.appHeader}>
        {details.iconDataUrl ? (
          <img src={details.iconDataUrl} style={panelStyles.appIcon} alt="" />
        ) : (
          <div style={{ ...panelStyles.appIcon, background: "#2a2a2c" }} />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={panelStyles.appName}>
            {details.displayName ?? details.bundleId}
            {details.loading && <span style={panelStyles.spinner}> …</span>}
          </div>
          <div style={panelStyles.appBundle} title={details.bundleId}>
            {details.bundleId}
          </div>
        </div>
      </div>

      {details.error && <div style={panelStyles.error}>{details.error}</div>}

      <dl style={panelStyles.dl}>
        <Row label="Version" value={details.shortVersion ? `${details.shortVersion} (${details.bundleVersion ?? "—"})` : details.loading ? "…" : "—"} />
        <Row label="Min iOS" value={details.minOS ?? (details.loading ? "…" : "—")} />
        <Row label="Executable" value={details.executable ?? (details.loading ? "…" : "—")} />
        <Row label="PID" value={details.pid != null ? String(details.pid) : "—"} />
        {details.isReactNative && <Row label="React Native" value="Yes" />}
        <Row
          label="App path"
          value={details.appPath ?? (details.loading ? "…" : "—")}
          mono
          action={
            details.appPath
              ? {
                  title: "Reveal in Finder",
                  onClick: () => { execOnHost(`open -R ${shellEscape(details.appPath!)}`); },
                  icon: (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="7" y1="17" x2="17" y2="7" />
                      <polyline points="10 7 17 7 17 14" />
                    </svg>
                  ),
                }
              : undefined
          }
        />
      </dl>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  action?: { title: string; onClick: () => void; icon: ReactNode };
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={panelStyles.row}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <dt style={panelStyles.dt}>{label}</dt>
      <dd
        style={{
          ...panelStyles.dd,
          fontFamily: mono ? "ui-monospace, monospace" : undefined,
          fontSize: mono ? 11 : 12,
          position: "relative",
        }}
        title={value}
      >
        {value}
        {action && (
          <div
            style={{
              ...panelStyles.rowActionWrap,
              opacity: hover ? 1 : 0,
              transform: hover ? "translateX(0)" : "translateX(4px)",
              pointerEvents: hover ? "auto" : "none",
            }}
          >
            <button
              type="button"
              onClick={action.onClick}
              title={action.title}
              aria-label={action.title}
              style={panelStyles.rowAction}
            >
              {action.icon}
            </button>
          </div>
        )}
      </dd>
    </div>
  );
}

// ─── Permissions tool ───
//
// Drives `xcrun simctl privacy <udid> <grant|revoke|reset> <service> <bundleId>`.
// Service names are simctl's, not TCC's. We don't read current state — the
// last action the user pressed is highlighted as the assumed status until they
// reset (which clears highlight).

const PERMISSION_SERVICES: { key: string; label: string }[] = [
  { key: "camera", label: "Camera" },
  { key: "microphone", label: "Microphone" },
  { key: "photos", label: "Photos" },
  { key: "photos-add", label: "Add to Photos" },
  { key: "contacts", label: "Contacts" },
  { key: "calendar", label: "Calendar" },
  { key: "reminders", label: "Reminders" },
  { key: "location", label: "Location" },
  { key: "location-always", label: "Location (Always)" },
  { key: "motion", label: "Motion" },
  { key: "media-library", label: "Media Library" },
  { key: "siri", label: "Siri" },
];

type PermAction = "grant" | "revoke" | "reset";
type PermState = Record<string, PermAction | undefined>;

function AppPermissionsTool({
  udid,
  bundleId,
}: {
  udid: string;
  bundleId: string | null;
}) {
  const [state, setState] = useState<PermState>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Reset assumed state whenever the foreground app changes.
  useEffect(() => { setState({}); setError(null); }, [bundleId]);

  const apply = useCallback(
    async (service: string, action: PermAction) => {
      if (!bundleId) return;
      const key = `${service}:${action}`;
      setPending(key);
      setError(null);
      try {
        const res = await execOnHost(
          `xcrun simctl privacy ${udid} ${action} ${service} ${shellEscape(bundleId)}`,
        );
        if (res.exitCode !== 0) {
          setError(res.stderr.trim() || `simctl privacy failed (exit ${res.exitCode})`);
          return;
        }
        setState((s) => ({ ...s, [service]: action === "reset" ? undefined : action }));
      } finally {
        setPending(null);
      }
    },
    [udid, bundleId],
  );

  const resetAll = useCallback(async () => {
    if (!bundleId) return;
    setPending("__all__");
    setError(null);
    try {
      const res = await execOnHost(
        `xcrun simctl privacy ${udid} reset all ${shellEscape(bundleId)}`,
      );
      if (res.exitCode !== 0) {
        setError(res.stderr.trim() || `simctl privacy failed (exit ${res.exitCode})`);
        return;
      }
      setState({});
    } finally {
      setPending(null);
    }
  }, [udid, bundleId]);

  if (!bundleId) {
    return (
      <div style={panelStyles.empty}>
        Permissions appear once an app is in the foreground.
      </div>
    );
  }

  return (
    <div style={{ ...panelStyles.section, padding: "8px 12px" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={panelStyles.permsToggle}
        aria-expanded={open}
      >
        <span style={{ ...panelStyles.sectionTitle, margin: 0 }}>Permissions</span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
            flexShrink: 0,
          }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {open && error && <div style={{ ...panelStyles.error, marginTop: 8 }}>{error}</div>}

      {open && <div style={panelStyles.permsScrollWrap}>
        <div style={panelStyles.permsScroll}>
        {PERMISSION_SERVICES.map(({ key, label }) => {
          const current = state[key];
          return (
            <div key={key} style={panelStyles.permRow}>
              <span style={panelStyles.permLabel}>{label}</span>
              <div style={panelStyles.permSeg} role="group" aria-label={label}>
                <PermBtn
                  active={current === "grant"}
                  pending={pending === `${key}:grant`}
                  onClick={() => apply(key, "grant")}
                  variant="grant"
                  title="Allow"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="5 12 10 17 19 7" />
                  </svg>
                </PermBtn>
                <PermBtn
                  active={current === "revoke"}
                  pending={pending === `${key}:revoke`}
                  onClick={() => apply(key, "revoke")}
                  variant="revoke"
                  title="Deny"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="18" y1="6" x2="6" y2="18" />
                  </svg>
                </PermBtn>
                <PermBtn
                  active={false}
                  pending={pending === `${key}:reset`}
                  onClick={() => apply(key, "reset")}
                  variant="reset"
                  title="Reset"
                >
                  <ReloadIcon size={11} strokeWidth={2.4} />
                </PermBtn>
              </div>
            </div>
          );
        })}
        </div>
        <div style={panelStyles.permsFadeTop} />
        <div style={panelStyles.permsFadeBottom} />
      </div>}

      {open && (
        <div style={panelStyles.permsFooter}>
          <button
            onClick={resetAll}
            disabled={pending === "__all__"}
            style={panelStyles.resetAllBtn}
            title="xcrun simctl privacy reset all"
          >
            {pending === "__all__" ? "…" : "Reset all"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Empty state: pick a simulator to boot ───
//
// When no serve-sim helper is running, the middleware has no state file to
// inject and `window.__SIM_PREVIEW__` is undefined. Instead of telling the
// user to drop into a terminal, list available simulators inline and let
// them boot one + start `serve-sim --detach` from the browser.

function BootEmptyState({
  devices,
  loading,
  error,
  onRefresh,
}: {
  devices: SimDevice[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [startingUdid, setStartingUdid] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const start = useCallback(async (d: SimDevice) => {
    if (startingUdid) return;
    setStartingUdid(d.udid);
    setStartError(null);
    try {
      if (d.state !== "Booted") {
        const boot = await execOnHost(`xcrun simctl boot ${d.udid}`);
        if (boot.exitCode !== 0) throw new Error(boot.stderr || "Failed to boot simulator");
      }
      const detach = await execOnHost(`bunx serve-sim --detach ${d.udid}`);
      if (detach.exitCode !== 0) throw new Error(detach.stderr || "Failed to start serve-sim");

      // Poll the middleware API until the state file is picked up, then reload. Avoids a
      // race where the user sees the empty state again because we reloaded
      // before serve-sim wrote its server-*.json.
      const deadline = Date.now() + 15_000;
      const apiUrl = `${simEndpoint("api")}?device=${encodeURIComponent(d.udid)}`;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(apiUrl, { cache: "no-store" });
          if (r.ok && (await r.json())) {
            const nextUrl = new URL(window.location.href);
            nextUrl.searchParams.set("device", d.udid);
            window.location.assign(nextUrl.toString());
            return;
          }
        } catch {}
        await new Promise((res) => setTimeout(res, 400));
      }
      throw new Error("serve-sim started but no stream state appeared");
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start stream");
      setStartingUdid(null);
    }
  }, [startingUdid]);

  const grouped = new Map<string, SimDevice[]>();
  for (const d of devices) {
    let list = grouped.get(d.runtime);
    if (!list) { list = []; grouped.set(d.runtime, list); }
    list.push(d);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => {
      // Booted first, then by device kind, then by name.
      const ab = a.state === "Booted" ? 0 : 1;
      const bb = b.state === "Booted" ? 0 : 1;
      if (ab !== bb) return ab - bb;
      return deviceKind(a.name) - deviceKind(b.name) || a.name.localeCompare(b.name);
    });
  }
  const sortedGroups = [...grouped.entries()].sort(
    ([a], [b]) => runtimeOrder(a) - runtimeOrder(b) || a.localeCompare(b),
  );

  return (
    <div style={s.page}>
      <div style={s.empty}>
        <h1 style={s.emptyTitle}>No serve-sim stream running</h1>
        <p style={s.emptyHint}>
          Pick a simulator to boot, or start one yourself with{" "}
          <code style={s.code}>bunx serve-sim --detach</code>.
        </p>
        <div style={bootListStyle}>
          <div style={pickerHeaderStyle}>
            <span style={{ fontWeight: 600 }}>Simulators</span>
            <button onClick={onRefresh} disabled={loading} style={pickerRefreshStyle}>
              {loading ? "..." : "Refresh"}
            </button>
          </div>
          {error && <div style={pickerErrorStyle}>{error}</div>}
          {startError && <div style={pickerErrorStyle}>{startError}</div>}
          {!loading && !error && devices.length === 0 && (
            <div style={pickerEmptyStyle}>No available simulators found</div>
          )}
          {sortedGroups.map(([runtime, devs]) => (
            <div key={runtime}>
              <div style={pickerGroupHeaderStyle}>{runtime}</div>
              {devs.map((d) => {
                const isStarting = startingUdid === d.udid;
                const disabled = startingUdid !== null && !isStarting;
                const isBooted = d.state === "Booted";
                return (
                  <div
                    key={d.udid}
                    style={{
                      ...pickerItemStyle,
                      cursor: disabled ? "default" : "pointer",
                      opacity: disabled ? 0.5 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!disabled) e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                    }}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    onClick={() => { if (!disabled) start(d); }}
                  >
                    <span style={dotStyle(isBooted ? "#4ade80" : "#444")} />
                    <span style={{ flex: 1, textAlign: "left" }}>{d.name}</span>
                    <span style={{ fontSize: 10, color: isStarting ? "#a5b4fc" : "#888" }}>
                      {isStarting
                        ? (isBooted ? "Starting..." : "Booting...")
                        : (isBooted ? "Start stream" : "Boot & stream")}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PermBtn({
  active,
  pending,
  onClick,
  variant,
  title,
  children,
}: {
  active: boolean;
  pending: boolean;
  onClick: () => void;
  variant: "grant" | "revoke" | "reset";
  title: string;
  children: ReactNode;
}) {
  const accent = variant === "grant" ? "#4ade80" : variant === "revoke" ? "#f87171" : "#a5b4fc";
  return (
    <button
      onClick={onClick}
      disabled={pending}
      title={title}
      aria-label={title}
      style={{
        ...panelStyles.permBtn,
        background: active ? `${accent}22` : "transparent",
        color: active ? accent : "rgba(255,255,255,0.55)",
        opacity: pending ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

interface AxTargetProps {
  element: AxElement;
  index: number;
  screen: { width: number; height: number };
  highlighted: boolean;
  selected: boolean;
  onHighlight: (key: string | null) => void;
  onSelect: (key: string | null) => void;
}

function axElementsEqual(a: AxElement, b: AxElement) {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.path !== b.path ||
    a.label !== b.label ||
    a.value !== b.value ||
    a.role !== b.role ||
    a.type !== b.type ||
    a.enabled !== b.enabled
  ) return false;
  const fa = a.frame, fb = b.frame;
  return (
    fa === fb ||
    (fa.x === fb.x && fa.y === fb.y && fa.width === fb.width && fa.height === fb.height)
  );
}

const AxTarget = memo(function AxTarget({
  element,
  index,
  screen,
  highlighted,
  selected,
  onHighlight,
  onSelect,
}: AxTargetProps) {
  const key = axElementKey(element);
  const axNode = axNodeForElement(element, index);
  const visibleFrame = clampAxFrameForScreen(element.frame, screen);
  if (!visibleFrame) return null;

  const summary = axElementSummary(axNode);
  return (
    <button
      type="button"
      data-ax-key={key}
      data-ax-id={axNode.id}
      data-ax-path={axNode.path}
      data-ax-label={axNode.label}
      data-ax-value={axNode.value}
      data-ax-role={axNode.role}
      data-ax-type={axNode.type}
      data-ax-enabled={String(axNode.enabled)}
      data-ax-frame={axFrameString(axNode.frame)}
      data-ax-selected={String(selected)}
      aria-label={element.label || summary}
      title={summary}
      onClick={() => onSelect(key)}
      onMouseEnter={() => onHighlight(key)}
      onMouseLeave={() => onHighlight(null)}
      style={{
        ...axStyles.target,
        left: `${(visibleFrame.x / screen.width) * 100}%`,
        top: `${(visibleFrame.y / screen.height) * 100}%`,
        width: `${(visibleFrame.width / screen.width) * 100}%`,
        height: `${(visibleFrame.height / screen.height) * 100}%`,
        borderColor: selected ? "#60a5fa" : highlighted ? "#fbbf24" : "#34d399",
        background: selected
          ? "rgba(96,165,250,0.24)"
          : highlighted
          ? "rgba(245,158,11,0.28)"
          : "rgba(16,185,129,0.12)",
      }}
    />
  );
}, (prev, next) =>
  prev.index === next.index &&
  prev.highlighted === next.highlighted &&
  prev.selected === next.selected &&
  prev.onHighlight === next.onHighlight &&
  prev.onSelect === next.onSelect &&
  prev.screen.width === next.screen.width &&
  prev.screen.height === next.screen.height &&
  axElementsEqual(prev.element, next.element));

function AxDomOverlay() {
  const { snapshot } = useAxSnapshotContext();
  const {
    highlightedKey,
    selectedKey,
    setHighlightedKey,
    setSelectedKey,
  } = useAxSelectionContext();

  if (!snapshot?.screen.width || !snapshot?.screen.height) return null;

  return (
    <div
      style={axStyles.targets}
    >
      {snapshot.elements.map((element, index) => {
        const key = axElementKey(element);
        return (
          <AxTarget
            key={key}
            element={element}
            index={index}
            screen={snapshot.screen}
            highlighted={key === highlightedKey}
            selected={key === selectedKey}
            onHighlight={setHighlightedKey}
            onSelect={setSelectedKey}
          />
        );
      })}
    </div>
  );
}

const AxTreeItem = memo(function AxTreeItem({
  element,
  index,
  active,
  onHighlight,
}: {
  element: AxElement;
  index: number;
  active: boolean;
  onHighlight: (key: string | null) => void;
}) {
  const key = axElementKey(element);
  const axNode = axNodeForElement(element, index);
  const size = `${Math.round(element.frame.width)}x${Math.round(element.frame.height)}`;
  const itemTitle = [
    axNode.label,
    axNode.role || axNode.type || "element",
    size,
  ].filter(Boolean).join(" · ");

  return (
    <div
      role="listitem"
      tabIndex={0}
      data-ax-key={key}
      title={itemTitle}
      onMouseEnter={() => onHighlight(key)}
      onMouseLeave={() => onHighlight(null)}
      onFocus={() => onHighlight(key)}
      onBlur={() => onHighlight(null)}
      style={{
        ...axStyles.listItem,
        ...(active ? axStyles.listItemActive : {}),
      }}
    >
      <span style={axStyles.itemText}>
        <span style={axStyles.itemLabel}>{element.label || element.role || "Unlabeled"}</span>
        <span style={axStyles.itemMeta}>{element.role || element.type || "element"}</span>
      </span>
      <code style={axStyles.itemSize}>{size}</code>
    </div>
  );
}, (prev, next) =>
  prev.index === next.index &&
  prev.active === next.active &&
  prev.onHighlight === next.onHighlight &&
  axElementsEqual(prev.element, next.element));

function AxTreeTool({
  overlayEnabled,
  onToggleOverlay,
}: {
  overlayEnabled: boolean;
  onToggleOverlay: () => void;
}) {
  const { snapshot } = useAxSnapshotContext();
  const { highlightedKey, setHighlightedKey } = useAxSelectionContext();
  const elements = snapshot?.elements ?? [];
  const axeUnavailable = isAxeUnavailable(snapshot);
  const error = snapshot?.errors?.[0] ?? null;
  return (
    <div style={{ ...panelStyles.section, padding: "8px 12px" }}>
      <div style={axStyles.panelHeader}>
        <span style={{ ...panelStyles.sectionTitle, margin: 0 }}>AX Tree</span>
        <button
          type="button"
          onClick={onToggleOverlay}
          aria-pressed={overlayEnabled}
          style={axStyles.overlayToggle}
        >
          {overlayEnabled ? "Overlay on" : "Enable overlay"}
        </button>
      </div>
      {!overlayEnabled ? (
        null
      ) : axeUnavailable ? (
        <div style={{ ...panelStyles.empty, padding: 12 }}>
          AX unavailable on this simulator.
        </div>
      ) : elements.length === 0 ? (
        <div style={{ ...panelStyles.empty, padding: 12 }}>
          {error ?? "Waiting for accessibility data…"}
        </div>
      ) : (
        <div style={axStyles.list} role="list">
          {elements.map((element, index) => {
            const key = axElementKey(element);
            return (
              <AxTreeItem
                key={key}
                element={element}
                index={index}
                active={key === highlightedKey}
                onHighlight={setHighlightedKey}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function axNodeForElement(element: AxElement, index: number) {
  const label = element.label || element.role || `element ${index + 1}`;
  const role = element.role || element.type;
  return {
    id: element.id,
    path: element.path,
    label,
    value: element.value,
    role,
    type: element.type,
    enabled: element.enabled,
    frame: element.frame,
  };
}

function clampAxFrameForScreen(
  frame: AxRect,
  screen: { width: number; height: number },
): AxRect | null {
  const x = Math.max(0, frame.x);
  const y = Math.max(0, frame.y);
  const right = Math.min(screen.width, frame.x + frame.width);
  const bottom = Math.min(screen.height, frame.y + frame.height);
  const width = Math.max(0, right - x);
  const height = Math.max(0, bottom - y);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function axElementKey(element: AxElement) {
  // element.id is AXUniqueId when present, otherwise falls back to path.
  // Prefer it over path so React keys and selection survive sibling reorders.
  return element.id;
}

function axElementSummary(axNode: ReturnType<typeof axNodeForElement>) {
  const parts = [
    `AX label: ${axNode.label || "Unlabeled"}`,
    axNode.role ? `role: ${axNode.role}` : "",
    axNode.type ? `type: ${axNode.type}` : "",
    axNode.value ? `value: ${axNode.value}` : "",
    axNode.id ? `id: ${axNode.id}` : "",
    `path: ${axNode.path}`,
    `frame: ${axFrameString(axNode.frame)}`,
  ];
  return parts.filter(Boolean).join("; ");
}

function axFrameString(frame: AxRect) {
  return `${frame.x},${frame.y} ${frame.width}x${frame.height}`;
}

function AxToolbarButton({
  overlayEnabled,
  streaming,
  onToggleOverlay,
}: {
  overlayEnabled: boolean;
  streaming: boolean;
  onToggleOverlay: () => void;
}) {
  const { status } = useAxSnapshotContext();
  const [hovered, setHovered] = useState(false);

  return (
    <SimulatorToolbar.Button
      aria-label={overlayEnabled ? "Hide accessibility overlay" : "Show accessibility overlay"}
      aria-pressed={overlayEnabled}
      title={status}
      onClick={onToggleOverlay}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={
        overlayEnabled && streaming
          ? {
              ...axStyles.toolbarButtonActive,
              ...(hovered ? axStyles.toolbarButtonActiveHover : {}),
            }
          : undefined
      }
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8V5a2 2 0 0 1 2-2h3" />
        <path d="M16 3h3a2 2 0 0 1 2 2v3" />
        <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
        <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
        <circle cx="12" cy="12" r="3.5" />
      </svg>
    </SimulatorToolbar.Button>
  );
}

// Persists a width to localStorage and exposes a pointer-driven resize handler.
// The panels live at the right edge, so dragging the handle leftwards grows
// the panel — the delta is `startX - clientX`.
function useResizableWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number,
) {
  const clamp = useCallback(
    (w: number) => Math.max(min, Math.min(max, w)),
    [min, max],
  );
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return defaultWidth;
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw != null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clamp(parsed) : defaultWidth;
  });
  // Re-clamp if the viewport shrinks below the saved width.
  const effectiveMax = typeof window !== "undefined"
    ? Math.min(max, window.innerWidth - 32)
    : max;
  const effectiveWidth = Math.max(min, Math.min(effectiveMax, width));

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = effectiveWidth;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const next = clamp(startWidth + (startX - ev.clientX));
        setWidth(next);
      };
      const up = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        try {
          window.localStorage.setItem(storageKey, String(clamp(startWidth + (startX - ev.clientX))));
        } catch {}
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    },
    [clamp, effectiveWidth, storageKey],
  );

  return { width: effectiveWidth, onPointerDown };
}

// Rendered as a fixed-positioned sibling of the panel, so the grabber can
// straddle the panel's left border without being clipped by overflow:hidden.
// The panel's own 1px border serves as the "line" — we just brighten it and
// add a centered pill on hover/drag.
function ResizeHandle({
  panelWidth,
  visible,
  onPointerDown,
  ariaLabel,
}: {
  panelWidth: number;
  visible: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const hot = hover || active;
  // Panel sits at right:12 with the given width — its left border is at
  // right:(12 + panelWidth - 1). Centering the 16px hit target there:
  const handleRight = 12 + panelWidth - 9;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-hidden={!visible}
      onPointerDown={(e) => {
        setActive(true);
        onPointerDown(e);
      }}
      onPointerUp={() => setActive(false)}
      onPointerCancel={() => setActive(false)}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: "fixed",
        top: 12,
        bottom: 12,
        right: handleRight,
        width: 16,
        cursor: "col-resize",
        zIndex: 36,
        touchAction: "none",
        pointerEvents: visible ? "auto" : "none",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.2s ease",
      }}
    >
      {/* Subtle hairline accent that brightens the panel's existing border
          while the edge is hot. Tapers at top/bottom. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "50%",
          width: 1,
          transform: "translateX(-0.5px)",
          background:
            "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.28) 30%, rgba(255,255,255,0.28) 70%, rgba(255,255,255,0) 100%)",
          opacity: hot ? 1 : 0,
          transition: "opacity 0.15s ease",
          pointerEvents: "none",
        }}
      />
      {/* Centered pill grabber, straddling the panel's left border. */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: 4,
          height: 28,
          borderRadius: 2,
          transform: "translate(-50%, -50%)",
          // Opaque so the hairline doesn't show through.
          background: active ? "#9a9a9e" : "#6e6e72",
          zIndex: 1,
          opacity: hot ? 1 : 0,
          transition: "opacity 0.15s ease, background 0.15s ease",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function ToolsPanel({
  open,
  onClose,
  udid,
  currentApp,
  axOverlayEnabled,
  onToggleAxOverlay,
  width,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
  axOverlayEnabled: boolean;
  onToggleAxOverlay: () => void;
  width: number;
}) {
  return (
    <aside
      style={{
        ...panelStyles.panel,
        width,
        transform: open ? "translateX(0)" : "translateX(calc(100% + 24px))",
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
      }}
      aria-hidden={!open}
    >
      <header style={panelStyles.header}>
        <span style={panelStyles.headerTitle}>Tools</span>
        <button onClick={onClose} style={panelStyles.closeBtn} aria-label="Close panel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      {open && (
        <div style={panelStyles.body}>
          <AxTreeTool
            overlayEnabled={axOverlayEnabled}
            onToggleOverlay={onToggleAxOverlay}
          />
          <AppDetectionTool udid={udid} currentApp={currentApp} />
          <AppPermissionsTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
        </div>
      )}
    </aside>
  );
}

function WebKitDevtoolsPanel({
  open,
  onClose,
  udid,
  targets,
  selectedTargetId,
  onSelectTarget,
  loading,
  error,
  onRefresh,
  width,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  targets: WebKitDevtoolsTarget[];
  selectedTargetId: string | null;
  onSelectTarget: (id: string) => void;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  width: number;
}) {
  const selected = selectedTargetId
    ? targets.find((target) => target.id === selectedTargetId) ?? null
    : null;

  return (
    <aside
      style={{
        ...devtoolsStyles.panel,
        width,
        transform: open ? "translateX(0)" : "translateX(calc(100% + 24px))",
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
      }}
      aria-hidden={!open}
    >
      <header style={devtoolsStyles.header}>
        {targets.length > 0 ? (
          <WebKitTargetPicker
            udid={udid}
            targets={targets}
            selected={selected}
            onSelectTarget={onSelectTarget}
            onRefresh={onRefresh}
          />
        ) : (
          <span style={devtoolsStyles.emptyTarget}>
            {loading ? "Looking for Safari and inspectable webviews..." : "No inspectable Safari or WKWebView targets"}
          </span>
        )}
        <button onClick={onClose} style={devtoolsStyles.iconButton} aria-label="Close WebKit DevTools" title="Close">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div style={devtoolsStyles.frameWrap}>
        {error ? (
          <div style={devtoolsStyles.message}>{error}</div>
        ) : selected && open ? (
          // Mount the iframe only while the panel is visible. Unmounting tears
          // down the WebSocket so WIR releases the page; otherwise we'd hold
          // the inspector connection forever and block other debuggers (Safari
          // Develop menu, chrome://inspect, …) from attaching.
          <iframe
            key={selected.id}
            src={selected.devtoolsFrontendUrl}
            title={`WebKit DevTools - ${selected.title || selected.url || selected.id}`}
            style={devtoolsStyles.iframe}
            onLoad={(event) => collapseScreencastPane(event.currentTarget)}
          />
        ) : (
          <div style={devtoolsStyles.message}>
            {selected
              ? "DevTools paused — open the panel to reattach."
              : "Open Safari or an inspectable WKWebView in the simulator."}
          </div>
        )}
      </div>
    </aside>
  );
}

const bootListStyle: CSSProperties = {
  width: "100%",
  maxWidth: 360,
  marginTop: 8,
  background: "#1c1c1e",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  padding: 4,
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  color: "#eee",
  textAlign: "left",
  maxHeight: "70vh",
  overflowY: "auto",
  minHeight: 0,
};

// ─── App ───

function App() {
  const config = window.__SIM_PREVIEW__;
  const [streaming, setStreaming] = useState(false);
  const [devices, setDevices] = useState<SimDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [stoppingUdids, setStoppingUdids] = useState<Set<string>>(new Set());
  const [switching, setSwitching] = useState(false);
  const [axOverlayEnabled, setAxOverlayEnabled] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [selectedDevtoolsTargetId, setSelectedDevtoolsTargetId] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const res = await execOnHost("xcrun simctl list devices available -j");
      if (res.exitCode !== 0) throw new Error(res.stderr || "simctl list failed");
      setDevices(parseSimctlList(res.stdout));
    } catch (err) {
      setDevicesError(err instanceof Error ? err.message : "Failed to list devices");
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);

  // Stream simctl logs into the browser console with colors + grouping
  useEffect(() => {
    if (!config?.logsEndpoint) return;
    const es = new EventSource(config.logsEndpoint);

    const procColors = new Map<string, string>();
    const palette = [
      "#8be9fd", "#50fa7b", "#ffb86c", "#ff79c6", "#bd93f9",
      "#f1fa8c", "#6272a4", "#ff5555", "#69ff94", "#d6acff",
      "#ffffa5", "#a4ffff", "#ff6e6e", "#caa9fa", "#5af78e",
    ];
    function colorFor(name: string): string {
      let c = procColors.get(name);
      if (!c) {
        let h = 0;
        for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
        c = palette[Math.abs(h) % palette.length];
        procColors.set(name, c);
      }
      return c;
    }

    let lastProc = "";
    let groupOpen = false;

    es.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data);
        const proc = entry.processImagePath?.split("/").pop() ?? entry.senderImagePath?.split("/").pop() ?? "";
        const subsystem = entry.subsystem ?? "";
        const category = entry.category ?? "";
        const msg = entry.eventMessage ?? "";
        if (!msg) return;

        if (proc !== lastProc) {
          if (groupOpen) console.groupEnd();
          const color = colorFor(proc);
          console.groupCollapsed(
            `%c${proc}${subsystem ? ` %c${subsystem}${category ? ":" + category : ""}` : ""}`,
            `color:${color};font-weight:bold`,
            ...(subsystem ? ["color:#888;font-weight:normal"] : []),
          );
          groupOpen = true;
          lastProc = proc;
        }

        const level = (entry.messageType ?? "").toLowerCase();
        const tag = subsystem && proc === lastProc
          ? `%c${category || subsystem}%c `
          : "";
        const tagStyles = tag
          ? ["color:#888;font-style:italic", "color:inherit"]
          : [];

        if (level === "fault" || level === "error") {
          console.log(`${tag}%c${msg}`, ...tagStyles, "color:#ff5555");
        } else if (level === "debug") {
          console.log(`${tag}%c${msg}`, ...tagStyles, "color:#6272a4");
        } else {
          console.log(`${tag}%c${msg}`, ...tagStyles, "color:inherit");
        }
      } catch {}
    };

    return () => {
      if (groupOpen) console.groupEnd();
      es.close();
    };
  }, [config?.logsEndpoint]);

  if (!config) {
    return (
      <BootEmptyState
        devices={devices}
        loading={devicesLoading}
        error={devicesError}
        onRefresh={fetchDevices}
      />
    );
  }

  const selectedDevice = devices.find((d) => d.udid === config.device) ?? null;

  useEffect(() => {
    document.title = selectedDevice?.name
      ? `Simulator - ${selectedDevice.name}`
      : "Simulator Preview";
  }, [selectedDevice?.name]);

  const deviceType: DeviceType = getDeviceType(selectedDevice?.name);
  const devtools = useWebKitDevtools(config.devtoolsEndpoint ?? simEndpoint("devtools"), devtoolsOpen);

  useEffect(() => {
    if (!devtoolsOpen) return;
    if (selectedDevtoolsTargetId && devtools.targets.some((target) => target.id === selectedDevtoolsTargetId)) return;
    // Only auto-pick when there's no ambiguity (single inspectable target).
    // Otherwise let the user choose explicitly so we don't surprise them by
    // attaching to one app's webview when several are inspectable.
    setSelectedDevtoolsTargetId(devtools.targets.length === 1 ? devtools.targets[0].id : null);
  }, [devtoolsOpen, devtools.targets, selectedDevtoolsTargetId]);

  useEffect(() => {
    setSelectedDevtoolsTargetId(null);
  }, [config.device]);

  // Parse MJPEG stream into individual frames (Chrome doesn't support multipart/x-mixed-replace in <img>)
  const mjpeg = useMjpegStream(config.streamUrl);
  const [liveStreamConfig, setLiveStreamConfig] = useState<StreamConfig | null>(null);
  const activeStreamConfig = liveStreamConfig ?? mjpeg.config ?? fallbackScreenSize(deviceType, selectedDevice?.name);
  const imgBorderRadius = screenBorderRadius(deviceType, activeStreamConfig);
  const frameMaxWidth = simulatorMaxWidth(deviceType, activeStreamConfig);
  const frameAspectRatio = simulatorAspectRatio(activeStreamConfig);
  const frameDisplayConfig = displayStreamConfig(activeStreamConfig);
  const frameAspectRatioValue = frameDisplayConfig
    ? frameDisplayConfig.width / frameDisplayConfig.height
    : 1;

  // Touch/button relay via direct WebSocket
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let currentWs: WebSocket | null = null;

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1000);
    };

    const connect = () => {
      const ws = new WebSocket(config.wsUrl);
      ws.binaryType = "arraybuffer";
      currentWs = ws;
      wsRef.current = ws;
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        scheduleReconnect();
      };
      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current === currentWs) wsRef.current = null;
      currentWs?.close();
    };
  }, [config.wsUrl]);

  const sendWs = useCallback((tag: number, payload: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const msg = new Uint8Array(1 + json.length);
    msg[0] = tag;
    msg.set(json, 1);
    ws.send(msg);
  }, []);

  const onStreamTouch = useCallback((data: any) => sendWs(0x03, data), [sendWs]);
  const onStreamMultiTouch = useCallback((data: any) => sendWs(0x05, data), [sendWs]);
  const onStreamButton = useCallback((button: string) => sendWs(0x04, { button }), [sendWs]);
  const onScreenConfigChange = useCallback((next: StreamConfig) => {
    setLiveStreamConfig((prev) =>
      prev &&
      prev.width === next.width &&
      prev.height === next.height &&
      prev.orientation === next.orientation
        ? prev
        : next,
    );
  }, []);
  const rotateDevice = useCallback((orientation: SimulatorOrientation) => {
    sendWs(0x07, { orientation });
  }, [sendWs]);

  useEffect(() => {
    setLiveStreamConfig(null);
  }, [config.streamUrl]);

  useEffect(() => {
    const confirmedConfig = mjpeg.config;
    if (!confirmedConfig) return;
    setLiveStreamConfig((prev) =>
      prev &&
      prev.width === confirmedConfig.width &&
      prev.height === confirmedConfig.height &&
      prev.orientation === confirmedConfig.orientation
        ? prev
        : null,
    );
  }, [mjpeg.config?.width, mjpeg.config?.height, mjpeg.config?.orientation]);

  const sendKey = useCallback((type: "down" | "up", usage: number) => {
    sendWs(0x06, { type, usage });
  }, [sendWs]);

  // Subscribe to app-state SSE. Foreground-app changes and React Native
  // detection are filtered in the CLI so we just accept the events here.
  // Debounced commit: during launch/switch, iOS can fire multiple foreground
  // transitions within a few hundred ms (splash → app, scene restore, etc.).
  // Without this, the reload button flickers while an RN app is still loading.
  const [currentApp, setCurrentApp] = useState<{ bundleId: string; isReactNative: boolean; pid?: number } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const { width: toolsPanelWidth, onPointerDown: onToolsResize } = useResizableWidth(
    "serve-sim:tools-panel-width",
    PANEL_WIDTH,
    240,
    720,
  );
  const { width: devtoolsPanelWidth, onPointerDown: onDevtoolsResize } = useResizableWidth(
    "serve-sim:devtools-panel-width",
    DEVTOOLS_PANEL_WIDTH,
    420,
    1400,
  );
  const [viewportWidth, setViewportWidth] = useState(
    () => (typeof window !== "undefined" ? window.innerWidth : 0),
  );
  const [viewportHeight, setViewportHeight] = useState(
    () => (typeof window !== "undefined" ? window.innerHeight : 0),
  );
  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    const es = new EventSource(config.appStateEndpoint ?? simEndpoint("appstate"));
    let timer: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = (e) => {
      try {
        const next = JSON.parse(e.data) as { bundleId: string; pid?: number; isReactNative: boolean };
        if (timer) clearTimeout(timer);
        // Commit RN app instantly (show the button ASAP); delay non-RN so a
        // transient foreground blip doesn't hide it.
        const delay = next?.isReactNative ? 0 : 600;
        timer = setTimeout(() => setCurrentApp(next), delay);
      } catch {}
    };
    return () => { if (timer) clearTimeout(timer); es.close(); };
  }, [config.appStateEndpoint]);

  // Cmd+R to reload the RN/Expo bundle. RCTKeyCommands on iOS listens for
  // this combo and triggers DevSupport reload. We hold Meta, tap R, release.
  const sendReactNativeReload = useCallback(async () => {
    const META = 0xe3;
    const R = 0x15;
    sendKey("down", META);
    await new Promise((r) => setTimeout(r, 30));
    sendKey("down", R);
    await new Promise((r) => setTimeout(r, 30));
    sendKey("up", R);
    await new Promise((r) => setTimeout(r, 30));
    sendKey("up", META);
  }, [sendKey]);

  // Tracks whether the simulator currently has input focus. Mousedowns inside
  // the simulator container focus it; mousedowns elsewhere on the page blur
  // it, so the user can interact with toolbar dropdowns, devtools, etc.
  // without their typing leaking into the simulator.
  const simContainerRef = useRef<HTMLDivElement | null>(null);
  // Track the device's actual rendered width. With `maxHeight: 100%` and a
  // fixed aspect ratio, a short window can shrink the device below
  // `frameMaxWidth`, so we can't use the max alone to detect panel collisions.
  const [deviceRenderedWidth, setDeviceRenderedWidth] = useState(0);
  useEffect(() => {
    const el = simContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setDeviceRenderedWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [simFocused, setSimFocused] = useState(true);
  const simFocusedRef = useRef(true);
  simFocusedRef.current = simFocused;
  const pressedKeysRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const inside = !!simContainerRef.current?.contains(e.target as Node);
      setSimFocused(inside);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // When focus leaves the simulator, release any keys still held down so iOS
  // doesn't see stuck modifiers/keys.
  useEffect(() => {
    if (simFocused) return;
    const held = pressedKeysRef.current;
    if (held.size === 0) return;
    for (const usage of held) sendWs(0x06, { type: "up", usage });
    held.clear();
  }, [simFocused, sendWs]);

  // Forward all keyboard events from the browser window to the simulator as
  // USB HID Keyboard usage codes (Usage Page 0x07). Modifiers and regular
  // keys are sent as independent key events, matching what a physical keyboard
  // connected to iOS would produce.
  useEffect(() => {
    // Shortcuts we intercept locally instead of forwarding the raw keys —
    // matches Simulator.app so muscle memory carries over.
    const onKey = (e: KeyboardEvent, type: "down" | "up") => {
      if (!simFocusedRef.current) return;
      // Cmd+Shift+H → Home button (Simulator.app's shortcut).
      if (e.code === "KeyH" && e.metaKey && e.shiftKey) {
        e.preventDefault();
        if (type === "down" && !e.repeat) sendWs(0x04, { button: "home" });
        return;
      }
      // Cmd+Shift+A → toggle appearance (Simulator.app's shortcut).
      if (e.code === "KeyA" && e.metaKey && e.shiftKey) {
        e.preventDefault();
        if (type === "down" && !e.repeat) {
          // simctl has no toggle; query current, invert, set.
          execOnHost(`xcrun simctl ui ${config.device} appearance`).then((r) => {
            const next = r.stdout.trim() === "dark" ? "light" : "dark";
            return execOnHost(`xcrun simctl ui ${config.device} appearance ${next}`);
          }).catch(() => {});
        }
        return;
      }
      const usage = hidUsageForCode(e.code);
      if (usage == null) return;
      // Prevent browser-level shortcuts (Cmd+W, Tab focus, etc.) from
      // interfering while the simulator has input focus.
      e.preventDefault();
      if (type === "down") pressedKeysRef.current.add(usage);
      else pressedKeysRef.current.delete(usage);
      sendWs(0x06, { type, usage });
    };
    const down = (e: KeyboardEvent) => onKey(e, "down");
    const up = (e: KeyboardEvent) => onKey(e, "up");
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [sendWs, config.device]);

  const switchToDevice = useCallback(async (d: SimDevice) => {
    if (switching || d.udid === config.device) return;
    setSwitching(true);
    // Ensure the target simulator is booted (serve-sim boots on --detach but
    // this keeps the flow snappy) and spin up a helper bound to it. Do not
    // kill the current helper here; another preview window may be using it.
    try {
      if (d.state !== "Booted") {
        await execOnHost(`xcrun simctl boot ${d.udid}`);
      }
      const detach = await execOnHost(`bunx serve-sim --detach ${d.udid}`);
      if (detach.exitCode !== 0) throw new Error(detach.stderr || "Failed to start serve-sim");
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("device", d.udid);
      window.location.assign(nextUrl.toString());
    } catch {
      setSwitching(false);
    }
  }, [switching, config.device]);

  // Drag/drop images, videos, or .ipa files onto the simulator.
  // Media → Photos (addmedia); .ipa → install.
  const uploads = useUploadToasts();
  const mediaDrop = useMediaDrop({
    exec: execOnHost,
    udid: config.device,
    enabled: streaming,
    onUploadStart: uploads.add,
    onUploadEnd: (id, ok, message) =>
      uploads.update(id, { status: ok ? "success" : "error", message }),
    onUnsupported: (file) => {
      const id = uploads.add(file.name, "media");
      uploads.update(id, {
        status: "error",
        message: `Unsupported: ${file.type || fileExtension(file)}`,
      });
    },
  });

  const stopDevice = useCallback(async (udid: string) => {
    setStoppingUdids((prev) => new Set(prev).add(udid));
    try {
      await execOnHost(`xcrun simctl shutdown ${udid}`);
      await fetchDevices();
    } finally {
      setStoppingUdids((prev) => {
        const next = new Set(prev);
        next.delete(udid);
        return next;
      });
    }
  }, [fetchDevices]);

  const simulatorResize = useSimulatorResize({
    defaultWidth: frameMaxWidth,
    viewportWidth,
    viewportHeight,
    aspectRatio: frameAspectRatioValue,
    onStart: () => setSimFocused(false),
  });

  // Only shift the simulator when the panel would otherwise collide with it.
  // Plenty of room → no shift (device stays at viewport center).
  // Encroaching → shift just enough to maintain a gap.
  // Not enough room for both → fall back to no shift; the panel overlays.
  const panelWidthPx = devtoolsOpen ? devtoolsPanelWidth : panelOpen ? toolsPanelWidth : 0;
  const PANEL_RIGHT_OFFSET = 12;
  const PANEL_GAP = 24;
  const maxShift = panelWidthPx > 0 ? panelWidthPx + PANEL_GAP : 0;
  let shiftForPanel = 0;
  if (panelWidthPx > 0) {
    const panelLeftEdge = viewportWidth - PANEL_RIGHT_OFFSET - panelWidthPx;
    // Use the actually-rendered device width (clamped to the max) — it can
    // be smaller than the max when the window is too short for full size.
    const deviceWidth = deviceRenderedWidth > 0
      ? Math.min(deviceRenderedWidth, simulatorResize.width)
      : simulatorResize.width;
    const deviceRightAtCenter = viewportWidth / 2 + deviceWidth / 2;
    const overlap = deviceRightAtCenter - (panelLeftEdge - PANEL_GAP);
    if (overlap > 0) {
      // Shifting paddingRight by N moves the centered device left by N/2.
      const shiftNeeded = 2 * overlap;
      shiftForPanel = shiftNeeded <= maxShift ? shiftNeeded : 0;
    }
  }

  return (
    <AxStateProvider endpoint={axOverlayEnabled ? config?.axEndpoint : undefined}>
    <div
      style={{
        ...s.page,
        paddingRight: 24 + shiftForPanel,
        transition: simulatorResize.isResizing ? "none" : SIMULATOR_RESIZE_PAGE_TRANSITION,
      }}
    >
      <div
        style={{
          ...s.simulatorStack,
          width: simulatorResize.width,
          transition: simulatorResize.isResizing
            ? SIMULATOR_RESIZE_DRAG_TRANSITION
            : SIMULATOR_RESIZE_LAYOUT_TRANSITION,
        }}
      >
        <SimulatorToolbar
          exec={execOnHost}
          onRotate={rotateDevice}
          orientation={activeStreamConfig.orientation ?? null}
          deviceUdid={config.device}
          deviceName={selectedDevice?.name ?? null}
          deviceRuntime={selectedDevice?.runtime ?? null}
          streaming={streaming}
        >
          <DevicePicker
            devices={devices}
            selectedUdid={config.device}
            loading={devicesLoading}
            error={devicesError}
            stoppingUdids={stoppingUdids}
            onRefresh={fetchDevices}
            onSelect={switchToDevice}
            onStop={stopDevice}
            trigger={<SimulatorToolbar.Title />}
          />
          <SimulatorToolbar.Actions>
            {currentApp?.isReactNative && (
              <SimulatorToolbar.Button
                aria-label="Reload React Native bundle"
                title="Reload (Cmd+R)"
                onClick={() => void sendReactNativeReload()}
              >
                <ReloadIcon />
              </SimulatorToolbar.Button>
            )}
            <SimulatorToolbar.HomeButton
              onClick={(e) => { e.preventDefault(); onStreamButton("home"); }}
            />
            <AxToolbarButton
              overlayEnabled={axOverlayEnabled}
              streaming={streaming}
              onToggleOverlay={() => setAxOverlayEnabled((enabled) => !enabled)}
            />
            <SimulatorToolbar.RotateButton title="Rotate device" />
          </SimulatorToolbar.Actions>
        </SimulatorToolbar>
        <div
          ref={simContainerRef}
          style={{
            width: simulatorResize.width,
            maxHeight: "100%",
            aspectRatio: frameAspectRatio,
            position: "relative",
            transition: simulatorResize.isResizing
              ? SIMULATOR_RESIZE_DRAG_TRANSITION
              : SIMULATOR_RESIZE_LAYOUT_TRANSITION,
            willChange: simulatorResize.isResizing ? "width" : undefined,
          }}
          {...mediaDrop.dropZoneProps}
        >
          <SimulatorView
            url={config.url}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              pointerEvents: simulatorResize.isResizing ? "none" : undefined,
            }}
            imageStyle={{
              borderRadius: imgBorderRadius,
              cornerShape: "superellipse(1.3)",
            } as CSSProperties}
            hideControls
            onStreamingChange={setStreaming}
            onStreamTouch={onStreamTouch}
            onStreamMultiTouch={onStreamMultiTouch}
            onStreamButton={onStreamButton}
            subscribeFrame={mjpeg.subscribeFrame}
            streamFrame={mjpeg.frame}
            streamConfig={activeStreamConfig}
            onScreenConfigChange={onScreenConfigChange}
          />
          {axOverlayEnabled && <AxDomOverlay />}
          {mediaDrop.isDragOver && (
            <div style={{ ...s.dropOverlay, borderRadius: imgBorderRadius }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Drop media or .ipa</span>
            </div>
          )}
          <div
            ref={simulatorResize.handleRef}
            role="separator"
            aria-label="Resize simulator"
            aria-orientation="vertical"
            aria-valuemin={Math.round(SIMULATOR_RESIZE_MIN_WIDTH)}
            aria-valuemax={Math.round(simulatorResize.maxWidth)}
            aria-valuenow={Math.round(simulatorResize.width)}
            tabIndex={0}
            title="Drag to resize"
            onPointerDown={simulatorResize.onPointerDown}
            onPointerMove={simulatorResize.onPointerMove}
            onPointerUp={simulatorResize.onPointerEnd}
            onPointerCancel={simulatorResize.onPointerEnd}
            onLostPointerCapture={simulatorResize.onPointerEnd}
            onKeyDown={simulatorResize.onKeyDown}
            onPointerEnter={() => simulatorResize.setHandleHovered(true)}
            onPointerLeave={() => simulatorResize.setHandleHovered(false)}
            style={{
              ...s.resizeHandle,
              ...(simulatorResize.handleActive ? s.resizeHandleActive : {}),
            }}
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <path d="M9 13L13 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M5 13L13 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </div>
        </div>
      </div>

      {/* Upload toasts */}
      {uploads.toasts.length > 0 && (
        <div style={s.toastStack}>
          {uploads.toasts.map((t) => (
            <div key={t.id} style={s.toast}>
              <span style={{ ...s.dot, background: t.status === "uploading" ? "#a5b4fc" : t.status === "success" ? "#4ade80" : "#f87171" }} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.status === "uploading" &&
                  (t.kind === "ipa" ? `Installing ${t.name}…` : `Uploading ${t.name}…`)}
                {t.status === "success" &&
                  (t.kind === "ipa" ? `Installed ${t.name}` : `Added ${t.name} to Photos`)}
                {t.status === "error" && `${t.name}: ${t.message ?? "Upload failed"}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Right-edge sidebar rail. The Tools panel and the WebKit DevTools
          panel each get their own toggle here; opening one closes the other.
          The active toggle hides itself so the panel's own close button
          remains the only control on screen. */}
      <div
        style={{
          ...sidebarRailStyles.rail,
          opacity: panelOpen || devtoolsOpen ? 0 : 1,
          pointerEvents: panelOpen || devtoolsOpen ? "none" : "auto",
        }}
      >
        <button
          onClick={() => {
            setDevtoolsOpen(false);
            setPanelOpen((o) => !o);
          }}
          style={sidebarRailStyles.button}
          aria-label="Open tools panel"
          aria-pressed={panelOpen}
          title="Tools"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <line x1="15" y1="4" x2="15" y2="20" />
          </svg>
        </button>
        <button
          onClick={() => {
            setPanelOpen(false);
            setDevtoolsOpen((o) => !o);
          }}
          style={sidebarRailStyles.button}
          aria-label="Open WebKit DevTools"
          aria-pressed={devtoolsOpen}
          title="WebKit DevTools"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
            <path d="M2 12h20" />
          </svg>
        </button>
      </div>

      <ToolsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        udid={config.device}
        currentApp={currentApp}
        axOverlayEnabled={axOverlayEnabled}
        onToggleAxOverlay={() => setAxOverlayEnabled((enabled) => !enabled)}
        width={toolsPanelWidth}
      />
      <ResizeHandle
        panelWidth={toolsPanelWidth}
        visible={panelOpen}
        onPointerDown={onToolsResize}
        ariaLabel="Resize tools panel"
      />

      <WebKitDevtoolsPanel
        open={devtoolsOpen}
        onClose={() => setDevtoolsOpen(false)}
        udid={config.device}
        targets={devtools.targets}
        selectedTargetId={selectedDevtoolsTargetId}
        onSelectTarget={setSelectedDevtoolsTargetId}
        loading={devtools.loading}
        error={devtools.error}
        onRefresh={() => void devtools.refresh()}
        width={devtoolsPanelWidth}
      />
      <ResizeHandle
        panelWidth={devtoolsPanelWidth}
        visible={devtoolsOpen}
        onPointerDown={onDevtoolsResize}
        ariaLabel="Resize WebKit DevTools panel"
      />

      {/* Status bar */}
      <div style={s.bar}>
        <span style={{ ...s.live, color: streaming ? "#4ade80" : "#666" }}>
          <span style={{ ...s.dot, background: streaming ? "#4ade80" : "#666" }} />
          {streaming ? "live" : "connecting"}
        </span>
      </div>
    </div>
    </AxStateProvider>
  );
}

// ─── Styles (before mount — Preact renders synchronously) ───

const s: Record<string, CSSProperties> = {
  page: {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    height: "100vh", background: "#0a0a0a", padding: 24, gap: 12,
    fontFamily: "-apple-system, system-ui, sans-serif",
    boxSizing: "border-box",
  },
  simulatorStack: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    minWidth: 0,
    transition: SIMULATOR_RESIZE_LAYOUT_TRANSITION,
  },
  bar: {
    display: "flex", alignItems: "center", gap: 10,
    fontSize: 12, fontFamily: "ui-monospace, monospace", color: "#666",
  },
  live: { display: "flex", alignItems: "center", gap: 5, transition: "color 0.3s" },
  dot: { width: 6, height: 6, borderRadius: "50%", transition: "background 0.3s" },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" },
  emptyTitle: { fontSize: 18, margin: 0, color: "#eee" },
  emptyHint: { color: "#888", fontSize: 14, maxWidth: 480 },
  code: { background: "#222", padding: "2px 6px", borderRadius: 4, fontSize: 13 },
  dropOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    border: "2px dashed #a5b4fc",
    background: "rgba(99,102,241,0.12)",
    backdropFilter: "blur(2px)",
    color: "#a5b4fc",
    pointerEvents: "none",
    zIndex: 20,
  },
  resizeHandle: {
    position: "absolute",
    right: -34,
    bottom: 2,
    width: 28,
    height: 28,
    borderRadius: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "rgba(255,255,255,0.72)",
    background: "rgba(28,28,30,0.62)",
    border: "1px solid rgba(255,255,255,0.14)",
    boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    cursor: "nwse-resize",
    touchAction: "none",
    opacity: 0.72,
    transition: "opacity 0.18s ease, background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease",
    zIndex: 25,
  },
  resizeHandleActive: {
    opacity: 1,
    background: "rgba(44,44,46,0.82)",
    border: "1px solid rgba(255,255,255,0.28)",
    boxShadow: "0 10px 28px rgba(0,0,0,0.42), 0 0 0 4px rgba(255,255,255,0.08)",
  },
  toastStack: {
    position: "fixed",
    bottom: 16,
    right: 16,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    maxWidth: 320,
    zIndex: 30,
  },
  toast: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    background: "#1c1c1e",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    color: "#eee",
    fontSize: 12,
    fontFamily: "ui-monospace, monospace",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  },
};

const pickerMenuStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  minWidth: 260,
  maxHeight: 360,
  overflowY: "auto",
  background: "#1c1c1e",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  padding: 4,
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  color: "#eee",
  zIndex: 20,
};

const pickerHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "6px 10px",
  fontSize: 11,
  color: "#aaa",
};

const pickerRefreshStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#a5b4fc",
  fontSize: 11,
  cursor: "pointer",
  padding: 0,
};

const pickerErrorStyle: CSSProperties = {
  padding: "6px 10px",
  color: "#f87171",
  fontSize: 11,
};

const pickerItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  borderRadius: 6,
  cursor: "pointer",
  transition: "background 0.15s",
};

const pickerSeparatorStyle: CSSProperties = {
  height: 1,
  background: "rgba(255,255,255,0.08)",
  margin: "4px 0",
};

const pickerEmptyStyle: CSSProperties = {
  padding: 12,
  color: "rgba(255,255,255,0.4)",
  fontSize: 11,
  textAlign: "center",
};

const pickerGroupHeaderStyle: CSSProperties = {
  padding: "6px 10px 2px",
  fontSize: 10,
  fontWeight: 600,
  color: "rgba(255,255,255,0.4)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const PANEL_WIDTH = 320;
const DEVTOOLS_PANEL_WIDTH = 760;
const SIMULATOR_RESIZE_MIN_WIDTH = 280;
const SIMULATOR_RESIZE_MAX_SCALE = 3;
const SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME = 136;
const SIMULATOR_RESIZE_DRAG_TRANSITION = "width 70ms linear";
const SIMULATOR_RESIZE_LAYOUT_TRANSITION = "width 0.24s cubic-bezier(0.22, 1, 0.36, 1)";
const SIMULATOR_RESIZE_PAGE_TRANSITION = "padding-right 0.24s cubic-bezier(0.22, 1, 0.36, 1)";

function useSimulatorResize({
  defaultWidth,
  viewportWidth,
  viewportHeight,
  aspectRatio,
  onStart,
}: {
  defaultWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  aspectRatio: number;
  onStart: () => void;
}) {
  const [frameWidth, setFrameWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [handleHovered, setHandleHovered] = useState(false);
  const resizeStartRef = useRef<{ pointerId: number; startX: number; startY: number; startWidth: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const maxWidth = getSimulatorFrameMaxWidth(defaultWidth, viewportWidth, viewportHeight, aspectRatio);
  const width = clampSimulatorFrameWidth(
    frameWidth ?? defaultWidth,
    defaultWidth,
    viewportWidth,
    viewportHeight,
    aspectRatio,
  );

  useEffect(() => {
    if (frameWidth == null) return;
    const next = clampSimulatorFrameWidth(
      frameWidth,
      defaultWidth,
      viewportWidth,
      viewportHeight,
      aspectRatio,
    );
    if (next !== frameWidth) setFrameWidth(next);
  }, [aspectRatio, defaultWidth, frameWidth, viewportHeight, viewportWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const previousWebkitUserSelect = document.body.style.webkitUserSelect;
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.body.style.webkitUserSelect = previousWebkitUserSelect;
    };
  }, [isResizing]);

  const scheduleFrameWidth = useCallback((nextWidth: number) => {
    const clampedWidth = clampSimulatorFrameWidth(
      nextWidth,
      defaultWidth,
      viewportWidth,
      viewportHeight,
      aspectRatio,
    );
    if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      setFrameWidth(clampedWidth);
    });
  }, [aspectRatio, defaultWidth, viewportHeight, viewportWidth]);

  const stopResize = useCallback(() => {
    const pointerId = resizeStartRef.current?.pointerId;
    resizeStartRef.current = null;
    if (pointerId != null && pointerId >= 0) {
      const handle = handleRef.current;
      if (handle?.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
    }
    if (resizeFrameRef.current != null) {
      cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    setIsResizing(false);
  }, []);

  useEffect(() => {
    return () => stopResize();
  }, [stopResize]);

  useEffect(() => {
    if (!isResizing) return;

    const stop = () => stopResize();
    const stopWhenHidden = () => {
      if (document.visibilityState === "hidden") stopResize();
    };

    window.addEventListener("blur", stop);
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    document.addEventListener("visibilitychange", stopWhenHidden);

    return () => {
      window.removeEventListener("blur", stop);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      document.removeEventListener("visibilitychange", stopWhenHidden);
    };
  }, [isResizing, stopResize]);

  const onPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    stopResize();
  }, [stopResize]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: width,
    };
    onStart();
    setIsResizing(true);
  }, [onStart, width]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (event.buttons !== 1) {
      stopResize();
      return;
    }

    const deltaX = event.clientX - start.startX;
    const deltaY = (event.clientY - start.startY) * aspectRatio;
    const nextWidth = start.startWidth + (Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY);
    scheduleFrameWidth(nextWidth);
  }, [aspectRatio, scheduleFrameWidth, stopResize]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
    if (direction === 0) return;
    event.preventDefault();
    const step = event.shiftKey ? 80 : 24;
    setFrameWidth(clampSimulatorFrameWidth(
      width + (direction * step),
      defaultWidth,
      viewportWidth,
      viewportHeight,
      aspectRatio,
    ));
  }, [aspectRatio, defaultWidth, viewportHeight, viewportWidth, width]);

  return {
    handleRef,
    width,
    maxWidth,
    isResizing,
    handleActive: handleHovered || isResizing,
    setHandleHovered,
    onPointerDown,
    onPointerMove,
    onPointerEnd,
    onKeyDown,
  };
}

function clampSimulatorFrameWidth(
  value: number,
  defaultWidth: number,
  viewportWidth: number,
  viewportHeight: number,
  aspectRatio: number,
) {
  const maxWidth = getSimulatorFrameMaxWidth(defaultWidth, viewportWidth, viewportHeight, aspectRatio);
  const minWidth = Math.min(SIMULATOR_RESIZE_MIN_WIDTH, maxWidth);
  return Math.min(maxWidth, Math.max(minWidth, value));
}

function getSimulatorFrameMaxWidth(
  defaultWidth: number,
  viewportWidth: number,
  viewportHeight: number,
  aspectRatio: number,
) {
  const scaledMaxWidth = defaultWidth * SIMULATOR_RESIZE_MAX_SCALE;
  const viewportMaxWidth =
    viewportWidth > 0
      ? Math.max(SIMULATOR_RESIZE_MIN_WIDTH, viewportWidth - 48)
      : scaledMaxWidth;
  const viewportMaxHeight =
    viewportHeight > 0 && Number.isFinite(aspectRatio) && aspectRatio > 0
      ? Math.max(
          SIMULATOR_RESIZE_MIN_WIDTH,
          (viewportHeight - SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME) * aspectRatio,
        )
      : scaledMaxWidth;
  return Math.min(scaledMaxWidth, viewportMaxWidth, viewportMaxHeight);
}

const devtoolsStyles: Record<string, CSSProperties> = {
  panel: {
    position: "fixed",
    top: 12,
    right: 12,
    bottom: 12,
    width: `min(${DEVTOOLS_PANEL_WIDTH}px, calc(100vw - 32px))`,
    minWidth: 0,
    background: "rgba(20,20,22,0.92)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14,
    color: "#eee",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    transition: "transform 0.25s ease, opacity 0.2s ease",
    boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    fontFamily: "-apple-system, system-ui, sans-serif",
    zIndex: 35,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "6px 10px 6px 12px",
    flexShrink: 0,
  },
  titleGroup: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    minWidth: 0,
  },
  title: {
    fontSize: 11,
    fontWeight: 500,
    color: "rgba(255,255,255,0.55)",
    whiteSpace: "nowrap",
  },
  subtitle: {
    fontSize: 11,
    color: "rgba(255,255,255,0.38)",
    fontFamily: "ui-monospace, monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  iconButton: {
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    color: "rgba(255,255,255,0.68)",
    borderRadius: 5,
    cursor: "pointer",
    padding: 0,
  },
  targetBar: {
    minHeight: 36,
    display: "flex",
    alignItems: "center",
    padding: "6px 8px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    flexShrink: 0,
  },
  select: {
    width: "100%",
    minWidth: 0,
    height: 26,
    background: "#1c1c1e",
    color: "#eee",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 6,
    fontSize: 12,
    padding: "0 8px",
    outline: "none",
  },
  pickerWrap: {
    position: "relative",
    width: "100%",
    minWidth: 0,
  },
  pickerButton: {
    width: "100%",
    minWidth: 0,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    background: "#1c1c1e",
    color: "#eee",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 6,
    fontSize: 12,
    padding: "0 8px",
    cursor: "pointer",
    textAlign: "left",
  },
  pickerLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  pickerList: {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    margin: 0,
    padding: 4,
    listStyle: "none",
    background: "#1c1c1e",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    minWidth: 220,
    maxWidth: 360,
    maxHeight: 320,
    overflowY: "auto",
    zIndex: 50,
  },
  pickerItem: {
    display: "flex",
    flexDirection: "column",
    padding: "3px 8px",
    borderRadius: 4,
    cursor: "pointer",
    color: "rgba(255,255,255,0.85)",
    fontSize: 12,
    lineHeight: 1.35,
  },
  pickerItemSelected: {
    background: "rgba(255,255,255,0.06)",
  },
  pickerItemHovered: {
    background: "rgba(10,132,255,0.22)",
  },
  pickerItemDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
    fontStyle: "italic",
  },
  pickerGroup: {
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  pickerGroupHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 6px 2px",
    fontSize: 12,
    fontWeight: 600,
    color: "rgba(255,255,255,0.92)",
  },
  pickerGroupIconImg: {
    width: 16,
    height: 16,
    borderRadius: 3,
    flexShrink: 0,
    objectFit: "cover",
  },
  pickerGroupName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pickerGroupList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    paddingLeft: 26,
  },
  pickerItemTitle: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pickerItemUrl: {
    display: "block",
    fontFamily: "ui-monospace, monospace",
    fontSize: 10,
    color: "rgba(255,255,255,0.42)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  emptyTarget: {
    color: "rgba(255,255,255,0.48)",
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  frameWrap: {
    flex: 1,
    minHeight: 0,
    background: "#fff",
    position: "relative",
  },
  iframe: {
    width: "100%",
    height: "100%",
    border: "none",
    display: "block",
    background: "#fff",
  },
  message: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "#111113",
    color: "rgba(255,255,255,0.58)",
    textAlign: "center",
    fontSize: 13,
  },
};

const sidebarRailStyles: Record<string, CSSProperties> = {
  rail: {
    position: "fixed",
    top: 12,
    right: 12,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: 4,
    background: "rgba(20,20,22,0.8)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 10,
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    transition: "opacity 0.18s ease",
    zIndex: 40,
  },
  button: {
    width: 30,
    height: 30,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    borderRadius: 6,
    color: "rgba(255,255,255,0.7)",
    cursor: "pointer",
    transition: "background 0.15s ease, color 0.15s ease",
  },
};

const panelStyles: Record<string, CSSProperties> = {
  toggle: {
    position: "fixed",
    top: 16,
    right: 16,
    width: 30,
    height: 30,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    borderRadius: 6,
    color: "rgba(255,255,255,0.6)",
    cursor: "pointer",
    transition: "background 0.15s ease, color 0.15s ease",
    zIndex: 40,
  },
  panel: {
    position: "fixed",
    top: 12,
    right: 12,
    bottom: 12,
    width: PANEL_WIDTH,
    background: "rgba(20,20,22,0.92)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14,
    color: "#eee",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    transition: "transform 0.25s ease, opacity 0.2s ease",
    boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    fontFamily: "-apple-system, system-ui, sans-serif",
    zIndex: 35,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px 6px 12px",
  },
  headerTitle: { fontSize: 11, fontWeight: 500, color: "rgba(255,255,255,0.55)" },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "#aaa",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  body: { padding: 14, overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 12 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "rgba(255,255,255,0.5)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    margin: "0 0 10px",
  },
  section: {
    background: "#1c1c1e",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 10,
    padding: 12,
  },
  empty: {
    background: "#1c1c1e",
    border: "1px dashed rgba(255,255,255,0.1)",
    borderRadius: 10,
    padding: 16,
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
    textAlign: "center",
  },
  appHeader: { display: "flex", alignItems: "center", gap: 12, marginBottom: 10 },
  appIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    flexShrink: 0,
    objectFit: "cover",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  appName: {
    fontSize: 14,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  appBundle: {
    fontSize: 11,
    color: "rgba(255,255,255,0.5)",
    fontFamily: "ui-monospace, monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  spinner: { color: "rgba(255,255,255,0.4)", fontWeight: 400 },
  error: {
    background: "rgba(248,113,113,0.08)",
    border: "1px solid rgba(248,113,113,0.2)",
    color: "#fca5a5",
    fontSize: 11,
    padding: "6px 8px",
    borderRadius: 6,
    marginBottom: 10,
  },
  dl: { margin: 0, display: "flex", flexDirection: "column", gap: 6 },
  row: { display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 },
  dt: {
    margin: 0,
    fontSize: 11,
    color: "rgba(255,255,255,0.5)",
    width: 84,
    flexShrink: 0,
  },
  dd: {
    margin: 0,
    fontSize: 12,
    color: "#eee",
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowActionWrap: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    paddingLeft: 28,
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    background: "linear-gradient(to right, rgba(28,28,30,0) 0%, #1c1c1e 55%)",
    transition: "opacity 0.15s ease, transform 0.15s ease",
  },
  permsToggle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    background: "transparent",
    border: "none",
    color: "rgba(255,255,255,0.5)",
    padding: 0,
    margin: 0,
    cursor: "pointer",
    width: "100%",
    textAlign: "left",
    lineHeight: 1,
  },
  permsScrollWrap: {
    position: "relative",
    marginTop: 8,
  },
  permsScroll: {
    maxHeight: 260,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "8px 0",
    scrollbarWidth: "thin",
  },
  permsFadeTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 14,
    pointerEvents: "none",
    background: "linear-gradient(to bottom, #1c1c1e 0%, rgba(28,28,30,0) 100%)",
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  },
  permsFadeBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 14,
    pointerEvents: "none",
    background: "linear-gradient(to top, #1c1c1e 0%, rgba(28,28,30,0) 100%)",
  },
  permsFooter: {
    display: "flex",
    justifyContent: "flex-end",
    paddingTop: 8,
  },
  resetAllBtn: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.12)",
    color: "rgba(255,255,255,0.7)",
    fontSize: 10,
    padding: "3px 8px",
    borderRadius: 5,
    cursor: "pointer",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  permsList: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 },
  permRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "4px 2px",
  },
  permLabel: {
    fontSize: 12,
    color: "#eee",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    minWidth: 0,
  },
  permSeg: {
    display: "flex",
    gap: 2,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 6,
    padding: 2,
  },
  permBtn: {
    width: 24,
    height: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    padding: 0,
    transition: "background 0.12s, color 0.12s",
  },
  rowAction: {
    width: 20,
    height: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    borderRadius: 4,
    color: "#fff",
    cursor: "pointer",
    padding: 0,
  },
};

const axStyles: Record<string, CSSProperties> = {
  targets: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: 10,
  },
  target: {
    position: "absolute",
    boxSizing: "border-box",
    minWidth: 1,
    minHeight: 1,
    padding: 0,
    border: "1px solid #34d399",
    borderRadius: 3,
    cursor: "pointer",
    pointerEvents: "auto",
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  overlayToggle: {
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 5,
    background: "transparent",
    color: "rgba(255,255,255,0.7)",
    cursor: "pointer",
    fontSize: 10,
    padding: "3px 7px",
  },
  toolbarButtonActive: {
    background: "rgba(255,255,255,0.08)",
    color: "rgba(255,255,255,0.95)",
  },
  toolbarButtonActiveHover: {
    background: "rgba(255,255,255,0.12)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    marginTop: 8,
    padding: "8px 0",
    maxHeight: 260,
    overflowY: "auto",
    scrollbarWidth: "thin",
  },
  listItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderRadius: 6,
    padding: "4px 2px",
    minWidth: 0,
  },
  listItemActive: {
    background: "rgba(255,255,255,0.06)",
  },
  itemText: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  itemLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "#eee",
    fontSize: 12,
    fontWeight: 500,
  },
  itemMeta: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "rgba(255,255,255,0.45)",
    fontFamily: "ui-monospace, monospace",
    fontSize: 10,
  },
  itemSize: {
    flexShrink: 0,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 6,
    color: "rgba(255,255,255,0.55)",
    fontFamily: "ui-monospace, monospace",
    fontSize: 10,
    padding: "3px 6px",
  },
};

// ─── Mount ───

createRoot(document.getElementById("root")!).render(<App />);
