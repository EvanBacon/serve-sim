import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
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

import { ReloadIcon } from "./icons";
import { AxDomOverlay } from "./components/ax-dom-overlay";
import { AxStateProvider } from "./components/ax-state-provider";
import { AxToolbarButton } from "./components/ax-toolbar-button";
import { BootEmptyState } from "./components/boot-empty-state";
import { DevicePicker } from "./components/device-picker";
import { GridPanel } from "./components/grid-panel";
import { ResizeHandle } from "./components/resize-handle";
import { ToolsPanel } from "./components/tools-panel";
import { WebKitDevtoolsPanel } from "./components/webkit-devtools-panel";
import { useMediaDrop } from "./hooks/use-media-drop";
import { useMjpegStream } from "./hooks/use-mjpeg-stream";
import { useResizableWidth } from "./hooks/use-resizable-width";
import { useSimulatorResize } from "./hooks/use-simulator-resize";
import { useUploadToasts } from "./hooks/use-upload-toasts";
import { useWebKitDevtools } from "./hooks/use-webkit-devtools";
import { parseSimctlList, type SimDevice } from "./utils/devices";
import { fileExtension } from "./utils/drop";
import { execOnHost } from "./utils/exec";
import { hidUsageForCode } from "./utils/hid";
import {
  DEVTOOLS_PANEL_WIDTH,
  GRID_PANEL_WIDTH,
  PANEL_WIDTH,
} from "./utils/panel-widths";
import { simEndpoint } from "./utils/sim-endpoint";
import {
  SIMULATOR_RESIZE_DRAG_TRANSITION,
  SIMULATOR_RESIZE_LAYOUT_TRANSITION,
  SIMULATOR_RESIZE_PAGE_TRANSITION,
} from "./utils/simulator-resize";

const RESIZE_HANDLE_BASE: CSSProperties = {
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
};
const RESIZE_HANDLE_ACTIVE: CSSProperties = {
  opacity: 1,
  background: "rgba(44,44,46,0.82)",
  border: "1px solid rgba(255,255,255,0.28)",
  boxShadow: "0 10px 28px rgba(0,0,0,0.42), 0 0 0 4px rgba(255,255,255,0.08)",
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
  const [gridOpen, setGridOpen] = useState(false);
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
        c = palette[Math.abs(h) % palette.length]!;
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

  return (
    <AppWithConfig
      config={config}
      devices={devices}
      devicesLoading={devicesLoading}
      devicesError={devicesError}
      stoppingUdids={stoppingUdids}
      setStoppingUdids={setStoppingUdids}
      switching={switching}
      setSwitching={setSwitching}
      axOverlayEnabled={axOverlayEnabled}
      setAxOverlayEnabled={setAxOverlayEnabled}
      devtoolsOpen={devtoolsOpen}
      setDevtoolsOpen={setDevtoolsOpen}
      gridOpen={gridOpen}
      setGridOpen={setGridOpen}
      selectedDevtoolsTargetId={selectedDevtoolsTargetId}
      setSelectedDevtoolsTargetId={setSelectedDevtoolsTargetId}
      streaming={streaming}
      setStreaming={setStreaming}
      fetchDevices={fetchDevices}
    />
  );
}

interface AppWithConfigProps {
  config: NonNullable<Window["__SIM_PREVIEW__"]>;
  devices: SimDevice[];
  devicesLoading: boolean;
  devicesError: string | null;
  stoppingUdids: Set<string>;
  setStoppingUdids: React.Dispatch<React.SetStateAction<Set<string>>>;
  switching: boolean;
  setSwitching: (v: boolean) => void;
  axOverlayEnabled: boolean;
  setAxOverlayEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  devtoolsOpen: boolean;
  setDevtoolsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  gridOpen: boolean;
  setGridOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedDevtoolsTargetId: string | null;
  setSelectedDevtoolsTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  streaming: boolean;
  setStreaming: (v: boolean) => void;
  fetchDevices: () => Promise<void>;
}

function AppWithConfig({
  config,
  devices,
  devicesLoading,
  devicesError,
  stoppingUdids,
  setStoppingUdids,
  switching,
  setSwitching,
  axOverlayEnabled,
  setAxOverlayEnabled,
  devtoolsOpen,
  setDevtoolsOpen,
  gridOpen,
  setGridOpen,
  selectedDevtoolsTargetId,
  setSelectedDevtoolsTargetId,
  streaming,
  setStreaming,
  fetchDevices,
}: AppWithConfigProps) {
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
    setSelectedDevtoolsTargetId(devtools.targets.length === 1 ? devtools.targets[0]!.id : null);
  }, [devtoolsOpen, devtools.targets, selectedDevtoolsTargetId, setSelectedDevtoolsTargetId]);

  useEffect(() => {
    setSelectedDevtoolsTargetId(null);
  }, [config.device, setSelectedDevtoolsTargetId]);

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
  }, [mjpeg.config, mjpeg.config?.width, mjpeg.config?.height, mjpeg.config?.orientation]);

  const sendKey = useCallback((type: "down" | "up", usage: number) => {
    sendWs(0x06, { type, usage });
  }, [sendWs]);

  // Subscribe to app-state SSE.
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
  const { width: gridPanelWidth, onPointerDown: onGridResize } = useResizableWidth(
    "serve-sim:grid-panel-width",
    GRID_PANEL_WIDTH,
    360,
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
        const delay = next?.isReactNative ? 0 : 600;
        timer = setTimeout(() => setCurrentApp(next), delay);
      } catch {}
    };
    return () => { if (timer) clearTimeout(timer); es.close(); };
  }, [config.appStateEndpoint]);

  // Cmd+R to reload the RN/Expo bundle.
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

  const simContainerRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (simFocused) return;
    const held = pressedKeysRef.current;
    if (held.size === 0) return;
    for (const usage of held) sendWs(0x06, { type: "up", usage });
    held.clear();
  }, [simFocused, sendWs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent, type: "down" | "up") => {
      if (!simFocusedRef.current) return;
      if (e.code === "KeyH" && e.metaKey && e.shiftKey) {
        e.preventDefault();
        if (type === "down" && !e.repeat) sendWs(0x04, { button: "home" });
        return;
      }
      if (e.code === "KeyA" && e.metaKey && e.shiftKey) {
        e.preventDefault();
        if (type === "down" && !e.repeat) {
          execOnHost(`xcrun simctl ui ${config.device} appearance`).then((r) => {
            const next = r.stdout.trim() === "dark" ? "light" : "dark";
            return execOnHost(`xcrun simctl ui ${config.device} appearance ${next}`);
          }).catch(() => {});
        }
        return;
      }
      const usage = hidUsageForCode(e.code);
      if (usage == null) return;
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
  }, [switching, config.device, setSwitching]);

  const uploads = useUploadToasts();
  const mediaDrop = useMediaDrop({
    exec: execOnHost,
    udid: config.device,
    enabled: streaming,
    onUploadStart: uploads.add,
    onUploadProgress: uploads.setProgress,
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
  }, [fetchDevices, setStoppingUdids]);

  const simulatorResize = useSimulatorResize({
    defaultWidth: frameMaxWidth,
    viewportWidth,
    viewportHeight,
    aspectRatio: frameAspectRatioValue,
    onStart: () => setSimFocused(false),
  });

  // Only shift the simulator when the panel would otherwise collide with it.
  const panelWidthPx = devtoolsOpen
    ? devtoolsPanelWidth
    : gridOpen
    ? gridPanelWidth
    : panelOpen
    ? toolsPanelWidth
    : 0;
  const PANEL_RIGHT_OFFSET = 12;
  const PANEL_GAP = 24;
  const maxShift = panelWidthPx > 0 ? panelWidthPx + PANEL_GAP : 0;
  let shiftForPanel = 0;
  if (panelWidthPx > 0) {
    const panelLeftEdge = viewportWidth - PANEL_RIGHT_OFFSET - panelWidthPx;
    const deviceWidth = deviceRenderedWidth > 0
      ? Math.min(deviceRenderedWidth, simulatorResize.width)
      : simulatorResize.width;
    const deviceRightAtCenter = viewportWidth / 2 + deviceWidth / 2;
    const overlap = deviceRightAtCenter - (panelLeftEdge - PANEL_GAP);
    if (overlap > 0) {
      const shiftNeeded = 2 * overlap;
      shiftForPanel = shiftNeeded <= maxShift ? shiftNeeded : 0;
    }
  }

  return (
    <AxStateProvider endpoint={axOverlayEnabled ? config?.axEndpoint : undefined}>
    <div
      className="flex flex-col items-center justify-center h-screen bg-page py-6 pl-6 gap-3 font-system box-border"
      style={{
        paddingRight: 24 + shiftForPanel,
        transition: simulatorResize.isResizing ? "none" : SIMULATOR_RESIZE_PAGE_TRANSITION,
      }}
    >
      <div
        className="flex flex-col items-center gap-3 min-w-0"
        style={{
          width: simulatorResize.width,
          transition: simulatorResize.isResizing
            ? SIMULATOR_RESIZE_DRAG_TRANSITION
            : SIMULATOR_RESIZE_LAYOUT_TRANSITION,
        }}
      >
        <SimulatorToolbar
          exec={execOnHost}
          onRotate={rotateDevice}
          orientation={(activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? null}
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
          className="relative max-h-full"
          style={{
            width: simulatorResize.width,
            aspectRatio: frameAspectRatio,
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
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-accent bg-[rgba(99,102,241,0.12)] backdrop-blur-[2px] text-accent pointer-events-none z-20"
              style={{ borderRadius: imgBorderRadius }}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span className="text-[13px] font-medium">Drop media or .ipa</span>
            </div>
          )}
          <div
            ref={simulatorResize.handleRef}
            role="separator"
            aria-label="Resize simulator"
            aria-orientation="vertical"
            aria-valuemin={Math.round(simulatorResize.minWidth)}
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
              ...RESIZE_HANDLE_BASE,
              ...(simulatorResize.handleActive ? RESIZE_HANDLE_ACTIVE : {}),
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
        <div className="fixed bottom-4 right-4 flex flex-col gap-1.5 max-w-[320px] z-30">
          {uploads.toasts.map((t) => {
            const isError = t.status === "error";
            const isUploading = t.status === "uploading";
            // While transferring chunks, show "Uploading … N%". Once chunks
            // are done, the install/addmedia step has no progress signal, so
            // swap to a phase-specific verb and an indeterminate bar.
            const transferring = isUploading && t.progress !== null;
            const pct = t.progress != null ? Math.round(t.progress * 100) : 0;
            return (
              <div
                key={t.id}
                className={`flex flex-col gap-1.5 px-3 py-2 bg-panel border border-white/12 rounded-lg text-white/90 text-[12px] font-mono shadow-[0_4px_12px_rgba(0,0,0,0.4)] ${isError ? "select-text cursor-text" : "select-none cursor-default"}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="size-1.5 rounded-full shrink-0 [transition:background_0.3s]"
                    style={{ background: isUploading ? "#a5b4fc" : t.status === "success" ? "#4ade80" : "#f87171" }}
                  />
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {isUploading && transferring &&
                      `Uploading ${t.name}… ${pct}%`}
                    {isUploading && !transferring &&
                      (t.kind === "ipa" ? `Installing ${t.name}…` : `Adding ${t.name}…`)}
                    {t.status === "success" &&
                      (t.kind === "ipa" ? `Installed ${t.name}` : `Added ${t.name} to Photos`)}
                    {isError && `${t.name}: ${t.message ?? "Upload failed"}`}
                  </span>
                </div>
                {isUploading && (
                  <div className="relative h-[3px] w-full bg-white/8 rounded-[2px] overflow-hidden">
                    {transferring ? (
                      <div
                        className="h-full bg-accent rounded-[2px] [transition:width_120ms_linear]"
                        style={{ width: `${pct}%` }}
                      />
                    ) : (
                      <div className="serve-sim-toast-indeterminate absolute top-0 left-0 h-full w-[40%] bg-accent rounded-[2px]" />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Right-edge sidebar rail. */}
      <div
        className={`fixed top-3 right-3 flex flex-col gap-1 p-1 bg-panel-bg border border-white/8 rounded-[10px] backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)] [transition:opacity_0.18s_ease] z-40 ${(panelOpen || devtoolsOpen || gridOpen) ? "opacity-0 pointer-events-none" : "opacity-100 pointer-events-auto"}`}
      >
        <button
          onClick={() => {
            setDevtoolsOpen(false);
            setGridOpen(false);
            setPanelOpen((o) => !o);
          }}
          className="w-[30px] h-[30px] flex items-center justify-center bg-transparent border-none rounded-md text-white/70 cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
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
            setGridOpen(false);
            setDevtoolsOpen((o) => !o);
          }}
          className="w-[30px] h-[30px] flex items-center justify-center bg-transparent border-none rounded-md text-white/70 cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
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
        <button
          onClick={() => {
            setPanelOpen(false);
            setDevtoolsOpen(false);
            setGridOpen((o) => !o);
          }}
          className="w-[30px] h-[30px] flex items-center justify-center bg-transparent border-none rounded-md text-white/70 cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
          aria-label="Open simulator grid"
          aria-pressed={gridOpen}
          title="Simulators"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
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

      <GridPanel
        open={gridOpen}
        onClose={() => setGridOpen(false)}
        currentUdid={config.device}
        width={gridPanelWidth}
      />
      <ResizeHandle
        panelWidth={gridPanelWidth}
        visible={gridOpen}
        onPointerDown={onGridResize}
        ariaLabel="Resize simulators panel"
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
      <div className="flex items-center gap-2.5 text-[12px] font-mono text-white/40">
        <span
          className="flex items-center gap-[5px] [transition:color_0.3s]"
          style={{ color: streaming ? "#4ade80" : "#666" }}
        >
          <span
            className="size-1.5 rounded-full [transition:background_0.3s]"
            style={{ background: streaming ? "#4ade80" : "#666" }}
          />
          {streaming ? "live" : "connecting"}
        </span>
      </div>
    </div>
    </AxStateProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
