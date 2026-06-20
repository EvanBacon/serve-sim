import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  SimulatorView,
  digitalCrownDeltaFromWheel,
  displayStreamConfig,
  fallbackScreenSize,
  isLandscapeConfig,
  screenBorderRadius,
  SimulatorToolbar,
  getDeviceType,
  simulatorAspectRatio,
  simulatorMaxWidth,
  type DeviceType,
  type SimulatorOrientation,
  type StreamConfig,
} from "serve-sim-client/simulator";

import { Globe, PanelLeft, PanelRight, Upload } from "lucide-react";
import { ReloadIcon } from "./icons";
import { AxDomOverlay } from "./components/ax-dom-overlay";
import { AxStateProvider } from "./components/ax-state-provider";
import { AxToolbarButton } from "./components/ax-toolbar-button";
import { DevicePlaceholder } from "./components/device-placeholder";
import { DeviceKitChrome, type ChromeButtonPress } from "./components/device-chrome-frame";
import { GridPanel } from "./components/grid-panel";
import { ResizeHandle } from "./components/resize-handle";
import { SimulatorResizeCornerHandle } from "./components/simulator-resize-corner-handle";
import { ScreenshotToast } from "./components/screenshot-toast";
import { SimulatorResizeSizeBadge } from "./components/simulator-resize-size-badge";
import { StreamStatusPill } from "./components/stream-status-pill";
import { ToolsPanel } from "./components/tools-panel";
import {
  CODEC_PREFERENCE_STORAGE_KEY,
  type CodecPreference,
} from "./components/stream-settings-tool";
import { WebKitDevtoolsPanel } from "./components/webkit-devtools-panel";
import { useMediaDrop } from "./hooks/use-media-drop";
import { useMjpegStream } from "./hooks/use-mjpeg-stream";
import { useAvccStream } from "./hooks/use-avcc-stream";
import { useResizableWidth } from "./hooks/use-resizable-width";
import { useScreenshotToast } from "./hooks/use-screenshot-toast";
import { useSimulatorResize } from "./hooks/use-simulator-resize";
import { useUploadToasts } from "./hooks/use-upload-toasts";
import { useWebKitDevtools } from "./hooks/use-webkit-devtools";
import { useGridDevices } from "./hooks/use-grid-devices";
import type { DeviceKitChromeDescriptor } from "./utils/grid";
import {
  avccFallbackReducer,
  initialAvccFallback,
  AVCC_FRAME_TIMEOUT_MS,
} from "./avcc-fallback";
import { fileExtension } from "./utils/drop";
import { execOnHost, openHostEventStream } from "./utils/exec";
import { hidUsageForCode } from "./utils/hid";
import {
  DEVICE_SIDEBAR_WIDTH,
  DEVTOOLS_PANEL_WIDTH,
  PANEL_WIDTH,
} from "./utils/panel-widths";
import { simEndpoint, streamConfigFrom } from "./utils/sim-endpoint";
import {
  SIMULATOR_RESIZE_DRAG_TRANSITION,
  SIMULATOR_RESIZE_LAYOUT_TRANSITION,
  SIMULATOR_RESIZE_PAGE_TRANSITION,
} from "./utils/simulator-resize";
import {
  flushWsMessageQueue,
  sendOrQueueWsMessage,
  type QueuedWsMessage,
} from "./utils/ws-send-queue";

// Counter-clockwise cycle, matching Simulator.app's Cmd+Left ("Rotate Left").
const ROTATE_LEFT_CYCLE: Record<SimulatorOrientation, SimulatorOrientation> = {
  portrait: "landscape_left",
  landscape_left: "portrait_upside_down",
  portrait_upside_down: "landscape_right",
  landscape_right: "portrait",
};
const ROTATE_RIGHT_CYCLE: Record<SimulatorOrientation, SimulatorOrientation> = {
  portrait: "landscape_right",
  landscape_right: "portrait_upside_down",
  portrait_upside_down: "landscape_left",
  landscape_left: "portrait",
};

// ─── App ───

type PreviewConfig = NonNullable<Window["__SIM_PREVIEW__"]>;

function previewConfigKey(config: PreviewConfig | null): string {
  return config
    ? `${config.device}:${config.pid}:${config.streamUrl}:${config.wsUrl}`
    : "";
}

// Left-edge rail button that reveals the device sidebar when it's collapsed.
// Mirrors the right-edge tools/devtools rail so the affordance reads the same.
function DeviceSidebarToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <div
      className={`fixed top-3 left-3 flex flex-col gap-1 p-1 [transition:opacity_0.18s_ease] z-40 ${open ? "opacity-0 pointer-events-none" : "opacity-100 pointer-events-auto"}`}
    >
      <button
        onClick={onClick}
        className="w-[30px] h-[30px] flex items-center justify-center bg-transparent border-none rounded-md text-[#8e8e93] cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
        aria-label="Open devices sidebar"
        aria-pressed={open}
        title="Devices"
      >
        <PanelLeft size={18} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function App() {
  const [config, setConfig] = useState<PreviewConfig | null>(() => streamConfigFrom(window.__SIM_PREVIEW__));
  const [streaming, setStreaming] = useState(false);
  // The device the user wants to view. Selecting a row in the sidebar updates
  // this and re-subscribes the SSE below — the main view swaps streams instantly
  // (or shows a Start placeholder) without a full page reload.
  const [selectedUdid, setSelectedUdid] = useState<string | null>(() => {
    const c = streamConfigFrom(window.__SIM_PREVIEW__);
    if (c) return c.device;
    return new URLSearchParams(window.location.search).get("device");
  });
  const [axOverlayEnabled, setAxOverlayEnabled] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  // Open the sidebar by default when the viewport has room for it beside the
  // simulator; narrow windows keep it collapsed so the device isn't squeezed.
  const [gridOpen, setGridOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth >= DEVICE_SIDEBAR_WIDTH + 520;
  });
  const { width: gridPanelWidth, onPointerDown: onGridResize } = useResizableWidth(
    "serve-sim:device-sidebar-width",
    DEVICE_SIDEBAR_WIDTH,
    240,
    640,
    "right",
  );
  const [selectedDevtoolsTargetId, setSelectedDevtoolsTargetId] = useState<string | null>(null);

  // Grid device list + boot/shutdown actions, shared by the sidebar and the
  // main placeholder. Endpoints resolve from simEndpoint so this also works in
  // the no-helper empty state (the grid routes are always served).
  const preview = window.__SIM_PREVIEW__;
  const gridApiEndpoint = preview?.gridApiEndpoint ?? simEndpoint("grid/api");
  const gridStartEndpoint = preview?.gridStartEndpoint ?? simEndpoint("grid/api/start");
  const gridShutdownEndpoint = preview?.gridShutdownEndpoint ?? simEndpoint("grid/api/shutdown");
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  const [shuttingDown, setShuttingDown] = useState<Record<string, boolean>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string | null>>({});
  // Devices we booted from the UI run the npm-published serve-sim helper, which
  // (unlike the local build serving this page) may not serve `/stream.avcc`.
  // Skip the H.264 path for them so the stream paints over MJPEG immediately
  // instead of stalling on the 4s AVCC-fallback window.
  const [uiStarted, setUiStarted] = useState<Set<string>>(() => new Set());
  const hasPending =
    Object.values(starting).some(Boolean) || Object.values(shuttingDown).some(Boolean);
  const { devices: gridDevices, refresh: refreshGrid } = useGridDevices(
    gridApiEndpoint,
    true,
    hasPending,
  );
  // Re-subscribe the stream SSE the instant the selected device gains (or loses)
  // a helper, so its config lands as soon as it boots rather than waiting on the
  // next filesystem-watch tick — the stream appears sooner after boot.
  const selectedHasHelper = !!(
    selectedUdid && gridDevices?.find((d) => d.device === selectedUdid)?.helper
  );

  const selectDevice = useCallback((udid: string) => {
    setSelectedUdid(udid);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("device", udid);
      window.history.replaceState(null, "", u.toString());
    } catch {}
  }, []);

  const waitForHelper = useCallback(
    async (udid: string, timeoutMs = 20_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(gridApiEndpoint, { cache: "no-store" });
          const json = await res.json();
          if ((json.devices ?? []).some((d: any) => d.device === udid && d.helper)) return true;
        } catch {}
        await new Promise((r) => setTimeout(r, 400));
      }
      return false;
    },
    [gridApiEndpoint],
  );

  const startDevice = useCallback(
    async (udid: string) => {
      setStarting((p) => ({ ...p, [udid]: true }));
      setActionErrors((e) => ({ ...e, [udid]: null }));
      try {
        const res = await fetch(gridStartEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udid }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          setActionErrors((e) => ({ ...e, [udid]: json.error ?? `HTTP ${res.status}` }));
          return;
        }
        setUiStarted((s) => (s.has(udid) ? s : new Set(s).add(udid)));
        // The helper registers asynchronously; once it does, the SSE (subscribed
        // to this udid) delivers its config and the main view starts streaming.
        await waitForHelper(udid);
      } catch (err: any) {
        setActionErrors((e) => ({ ...e, [udid]: err?.message ?? "Request failed" }));
      } finally {
        setStarting((p) => ({ ...p, [udid]: false }));
        refreshGrid();
      }
    },
    [gridStartEndpoint, waitForHelper, refreshGrid],
  );

  const shutdownDevice = useCallback(
    async (udid: string) => {
      setShuttingDown((s) => ({ ...s, [udid]: true }));
      setActionErrors((e) => ({ ...e, [udid]: null }));
      try {
        const res = await fetch(gridShutdownEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udid }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          setActionErrors((e) => ({ ...e, [udid]: json.error ?? `HTTP ${res.status}` }));
        }
      } catch (err: any) {
        setActionErrors((e) => ({ ...e, [udid]: err?.message ?? "Request failed" }));
      } finally {
        setShuttingDown((s) => ({ ...s, [udid]: false }));
        refreshGrid();
      }
    },
    [gridShutdownEndpoint, refreshGrid],
  );

  // Pick a sensible default device once the grid loads and nothing is selected:
  // prefer a live helper, then a booted sim, then the first available.
  useEffect(() => {
    if (selectedUdid) return;
    if (config?.device) {
      setSelectedUdid(config.device);
      return;
    }
    if (!gridDevices || gridDevices.length === 0) return;
    const pick =
      gridDevices.find((d) => d.helper) ??
      gridDevices.find((d) => d.state === "Booted") ??
      gridDevices[0];
    if (pick) setSelectedUdid(pick.device);
  }, [selectedUdid, config?.device, gridDevices]);

  // Subscribe to the selected device's stream config. Re-runs on selection
  // change so switching devices swaps the stream without reloading the page.
  useEffect(() => {
    const eventsUrl = `${simEndpoint("api/events")}${selectedUdid ? `?device=${encodeURIComponent(selectedUdid)}` : ""}`;

    const applyConfig = (next: PreviewConfig | null) => {
      setConfig((prev) => {
        if (previewConfigKey(prev) === previewConfigKey(next)) return prev;
        if (next) {
          window.__SIM_PREVIEW__ = next;
        } else if (window.__SIM_PREVIEW__) {
          // Keep the minimal injection: the empty state still routes through
          // simEndpoint (basePath) and authenticates /exec (execToken).
          const { basePath, execToken } = window.__SIM_PREVIEW__;
          window.__SIM_PREVIEW__ = { basePath, execToken } as Window["__SIM_PREVIEW__"];
        }
        return next;
      });
    };

    // Server pushes the serve-sim state only when it actually changes (helper
    // boot/shutdown or device selection), so there's no polling loop here.
    const es = openHostEventStream(eventsUrl);
    es.onmessage = (event) => {
      try {
        applyConfig(streamConfigFrom(JSON.parse(event.data) as Window["__SIM_PREVIEW__"]));
      } catch {}
    };
    return () => es.close();
  }, [selectedUdid, selectedHasHelper]);

  // Selection drives the view: stream when the selected device's helper config
  // has arrived, otherwise a placeholder (connecting / boot-and-start).
  const effectiveUdid = selectedUdid ?? config?.device ?? null;
  const selectedDevice = gridDevices?.find((d) => d.device === effectiveUdid) ?? null;
  const isStreaming = !!config && config.device === effectiveUdid;

  let mainView: ReactNode;
  if (isStreaming && config) {
    mainView = (
      <AppWithConfig
        config={config}
        deviceName={selectedDevice?.name ?? null}
        deviceRuntime={selectedDevice?.runtime ?? null}
        chrome={selectedDevice?.chrome ?? null}
        preferMjpeg={uiStarted.has(config.device)}
        axOverlayEnabled={axOverlayEnabled}
        setAxOverlayEnabled={setAxOverlayEnabled}
        devtoolsOpen={devtoolsOpen}
        setDevtoolsOpen={setDevtoolsOpen}
        gridOpen={gridOpen}
        setGridOpen={setGridOpen}
        gridPanelWidth={gridPanelWidth}
        selectedDevtoolsTargetId={selectedDevtoolsTargetId}
        setSelectedDevtoolsTargetId={setSelectedDevtoolsTargetId}
        streaming={streaming}
        setStreaming={setStreaming}
      />
    );
  } else {
    const leftPad = gridOpen ? gridPanelWidth + 36 : 24;
    mainView = (
      <div
        className="h-screen flex flex-col items-center justify-center gap-3 bg-page font-system box-border [transition:padding_0.25s_ease]"
        style={{ paddingLeft: leftPad, paddingRight: 24 }}
      >
        {selectedDevice ? (
          <DevicePlaceholder
            name={selectedDevice.name}
            runtime={selectedDevice.runtime}
            chrome={selectedDevice.chrome ?? null}
            placeholderAsset={selectedDevice.placeholderAsset ?? null}
            busy={!!selectedDevice.helper || !!starting[selectedDevice.device]}
            busyLabel={selectedDevice.helper ? "Connecting…" : "Starting…"}
            error={actionErrors[selectedDevice.device] ?? null}
            onStart={() => startDevice(selectedDevice.device)}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="text-[18px] m-0 text-white/90">No simulators available</h1>
            <p className="text-white/55 text-[14px] max-w-120">
              Create a simulator in Xcode, or start one with{" "}
              <code className="bg-[#222] px-1.5 py-0.5 rounded text-[13px]">bunx serve-sim --detach</code>.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {mainView}
      {/* Persistent left device sidebar — overlays every main view so swapping
          streams never remounts (and refetches) the picker. */}
      <GridPanel
        open={gridOpen}
        onClose={() => setGridOpen(false)}
        width={gridPanelWidth}
        side="left"
        devices={gridDevices}
        selectedUdid={effectiveUdid}
        onSelect={selectDevice}
        starting={starting}
        shuttingDown={shuttingDown}
        onShutdown={shutdownDevice}
      />
      <ResizeHandle
        panelWidth={gridPanelWidth}
        visible={gridOpen}
        onPointerDown={onGridResize}
        ariaLabel="Resize simulators sidebar"
        side="left"
      />
      <DeviceSidebarToggle open={gridOpen} onClick={() => setGridOpen(true)} />
    </>
  );
}

interface AppWithConfigProps {
  config: PreviewConfig;
  deviceName: string | null;
  deviceRuntime: string | null;
  chrome: DeviceKitChromeDescriptor | null;
  preferMjpeg: boolean;
  axOverlayEnabled: boolean;
  setAxOverlayEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  devtoolsOpen: boolean;
  setDevtoolsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  gridOpen: boolean;
  setGridOpen: React.Dispatch<React.SetStateAction<boolean>>;
  gridPanelWidth: number;
  selectedDevtoolsTargetId: string | null;
  setSelectedDevtoolsTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  streaming: boolean;
  setStreaming: (v: boolean) => void;
}

function AppWithConfig({
  config,
  deviceName,
  deviceRuntime,
  chrome,
  preferMjpeg,
  axOverlayEnabled,
  setAxOverlayEnabled,
  devtoolsOpen,
  setDevtoolsOpen,
  gridOpen,
  setGridOpen,
  gridPanelWidth,
  selectedDevtoolsTargetId,
  setSelectedDevtoolsTargetId,
  streaming,
  setStreaming,
}: AppWithConfigProps) {
  useEffect(() => {
    document.title = deviceName ? `Simulator - ${deviceName}` : "Simulator Preview";
  }, [deviceName]);

  const deviceType: DeviceType = getDeviceType(deviceName);
  const devtools = useWebKitDevtools(config.devtoolsEndpoint ?? simEndpoint("devtools"), devtoolsOpen);

  useEffect(() => {
    if (!devtoolsOpen) return;
    if (selectedDevtoolsTargetId && devtools.targets.some((target) => target.id === selectedDevtoolsTargetId)) return;
    setSelectedDevtoolsTargetId(devtools.targets.length === 1 ? devtools.targets[0]!.id : null);
  }, [devtoolsOpen, devtools.targets, selectedDevtoolsTargetId, setSelectedDevtoolsTargetId]);

  useEffect(() => {
    setSelectedDevtoolsTargetId(null);
  }, [config.device, setSelectedDevtoolsTargetId]);

  // Prefer H.264 (AVCC via WebCodecs) when the browser supports it; otherwise
  // fall back to MJPEG. The MJPEG reader stays dormant (null url) under AVCC so
  // we never pull both streams at once. The AVCC frames are decoded view-side
  // by SimulatorView's `useAvccStream`; this hook just reports browser support.
  //
  // Browser support is necessary but not sufficient: the helper may not serve
  // `/stream.avcc` at all. A device started from the UI is spawned via
  // `bunx serve-sim --detach`, which runs the published `serve-sim` — older
  // versions predate H.264 and 404 the endpoint (cross-origin that 404 is
  // opaque to fetch, so "no frame arrived" is the only reliable signal).
  // `avccFallback` drives a startup timeout: if AVCC paints nothing in time,
  // drop to MJPEG, which every helper serves. See avcc-fallback.ts.
  const avcc = useAvccStream();
  const [avccFallback, dispatchAvccFallback] = useReducer(
    avccFallbackReducer,
    initialAvccFallback,
  );
  // `?codec=mjpeg` forces the JPEG fallback path even where WebCodecs exists —
  // an escape hatch for browsers whose H.264 decode misbehaves, and the way to
  // exercise the MJPEG pipeline in a browser that would otherwise pick AVCC.
  const [forceMjpeg] = useState(
    () => new URLSearchParams(window.location.search).get("codec") === "mjpeg",
  );
  // User-selectable codec preference (Video section of the tools panel). "mjpeg"
  // forces the software path; the H.264 hardware decoder shares the GPU's
  // VideoToolbox pipeline with screen recorders, so MJPEG is the fix when the
  // stream stutters/drops while recording the browser window. Persisted so the
  // choice survives reloads.
  const [codecPreference, setCodecPreference] = useState<CodecPreference>(
    () => (window.localStorage.getItem(CODEC_PREFERENCE_STORAGE_KEY) === "mjpeg" ? "mjpeg" : "auto"),
  );
  useEffect(() => {
    window.localStorage.setItem(CODEC_PREFERENCE_STORAGE_KEY, codecPreference);
  }, [codecPreference]);
  const useAvccVideo =
    avcc.supported && !avccFallback.fellBack && !preferMjpeg && !forceMjpeg && codecPreference !== "mjpeg";
  const mjpeg = useMjpegStream(useAvccVideo ? null : config.streamUrl);

  // Re-arm AVCC whenever the target stream changes (device switch / reconnect).
  useEffect(() => {
    setStreaming(false);
    dispatchAvccFallback("reset");
  }, [config.streamUrl, setStreaming]);
  // `streaming` flips true on the first painted AVCC frame (JPEG seed decodes
  // sub-second on a healthy helper), which cancels the fallback.
  useEffect(() => {
    if (useAvccVideo && streaming) dispatchAvccFallback("frame");
  }, [useAvccVideo, streaming]);
  // One-shot startup window; on expiry fall back unless a frame already landed.
  useEffect(() => {
    if (!useAvccVideo) return;
    const timer = setTimeout(
      () => dispatchAvccFallback("timeout"),
      AVCC_FRAME_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [useAvccVideo, config.streamUrl]);
  const [liveStreamConfig, setLiveStreamConfig] = useState<StreamConfig | null>(null);
  // Screen config now arrives over the input WebSocket (pushed by the helper on
  // connect + on every dimension/orientation change) instead of a 1s /config poll.
  const [wsStreamConfig, setWsStreamConfig] = useState<StreamConfig | null>(null);
  const streamConfig = wsStreamConfig;
  const activeStreamConfig = liveStreamConfig ?? streamConfig ?? fallbackScreenSize(deviceType, deviceName);
  const imgBorderRadius = screenBorderRadius(deviceType, activeStreamConfig);
  const frameMaxWidth = simulatorMaxWidth(deviceType, activeStreamConfig);
  const frameAspectRatio = simulatorAspectRatio(activeStreamConfig);
  const frameDisplayConfig = displayStreamConfig(activeStreamConfig);
  const frameAspectRatioValue = frameDisplayConfig
    ? frameDisplayConfig.width / frameDisplayConfig.height
    : 1;

  // DeviceKit chrome wraps the live stream in the real device bezel (with
  // working hardware buttons). It's authored portrait, so in landscape we drop
  // back to the bare rounded screen. When chromed, the on-screen container is
  // the full frame (bezel + screen): `chromeScale` is how much bigger the frame
  // is than the screen, so we scale the container up by it while keeping the
  // *screen* at the same comfortable size — and resize / panel-collision math
  // all operate on the frame dimensions.
  const isLandscape = isLandscapeConfig(activeStreamConfig);
  const useChrome = !!chrome && !isLandscape;
  const chromeScale = useChrome ? chrome!.frame.width / chrome!.screen.width : 1;
  const containerDefaultWidth = frameMaxWidth * chromeScale;
  const containerAspectRatioValue = useChrome
    ? chrome!.frame.width / chrome!.frame.height
    : frameAspectRatioValue;
  const containerAspectRatio = useChrome
    ? `${chrome!.frame.width} / ${chrome!.frame.height}`
    : frameAspectRatio;

  // Touch/button relay via direct WebSocket
  const wsRef = useRef<WebSocket | null>(null);
  const pendingWsMessagesRef = useRef<QueuedWsMessage[]>([]);
  useEffect(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let currentWs: WebSocket | null = null;
    pendingWsMessagesRef.current = [];

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
      ws.onopen = () => {
        pendingWsMessagesRef.current = flushWsMessageQueue(
          ws,
          pendingWsMessagesRef.current,
        );
      };
      ws.onmessage = (ev) => {
        // Server -> client screen-config push (tag 0x82): [tag][JSON].
        if (!(ev.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(ev.data);
        if (bytes.length < 1 || bytes[0] !== 0x82) return;
        try {
          const cfg = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as StreamConfig;
          if (cfg.width <= 0 || cfg.height <= 0) return;
          setWsStreamConfig((prev) =>
            prev &&
            prev.width === cfg.width &&
            prev.height === cfg.height &&
            prev.orientation === cfg.orientation
              ? prev
              : cfg,
          );
        } catch {}
      };
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
    pendingWsMessagesRef.current = sendOrQueueWsMessage(
      wsRef.current,
      pendingWsMessagesRef.current,
      tag,
      payload,
    );
  }, []);

  const onStreamTouch = useCallback((data: any) => sendWs(0x03, data), [sendWs]);
  const onStreamMultiTouch = useCallback((data: any) => sendWs(0x05, data), [sendWs]);
  const onStreamButton = useCallback((button: string) => sendWs(0x04, { button }), [sendWs]);
  // A hardware button on the device chrome was pressed/released. Forward its HID
  // (page, usage) so the helper injects it via arbitrary HID — `down`/`up` phases
  // let power / side buttons be held for their long-press menus.
  const handleChromeButton = useCallback(
    ({ phase, button }: ChromeButtonPress) => {
      if (button.usagePage == null || button.usage == null) return;
      sendWs(0x04, {
        button: button.name,
        page: button.usagePage,
        usage: button.usage,
        phase,
      });
    },
    [sendWs],
  );
  const onStreamDigitalCrown = useCallback((delta: number) => sendWs(0x0a, { delta }), [sendWs]);
  const onStreamScroll = useCallback((data: { dx: number; dy: number; x: number; y: number }) => sendWs(0x0b, data), [sendWs]);
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
  const currentOrientation =
    (activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? "portrait";
  const canRotate = deviceType !== "watch" && deviceType !== "vision";
  const rotateBy = useCallback(
    (direction: "left" | "right") => {
      if (!canRotate) return;
      const next = (direction === "left" ? ROTATE_LEFT_CYCLE : ROTATE_RIGHT_CYCLE)[currentOrientation];
      rotateDevice(next);
    },
    [canRotate, currentOrientation, rotateDevice],
  );

  useEffect(() => {
    setLiveStreamConfig(null);
    setWsStreamConfig(null);
  }, [config.streamUrl]);

  useEffect(() => {
    const confirmedConfig = streamConfig;
    if (!confirmedConfig) return;
    setLiveStreamConfig((prev) =>
      prev &&
      prev.width === confirmedConfig.width &&
      prev.height === confirmedConfig.height &&
      prev.orientation === confirmedConfig.orientation
        ? prev
        : null,
    );
  }, [streamConfig, streamConfig?.width, streamConfig?.height, streamConfig?.orientation]);

  const sendKey = useCallback((type: "down" | "up", usage: number) => {
    sendWs(0x06, { type, usage });
  }, [sendWs]);

  // Subscribe to app-state SSE.
  const [currentApp, setCurrentApp] = useState<{ bundleId: string; isReactNative: boolean; pid?: number } | null>(null);
  // Start with the tools panel open when the viewport has room for it beside
  // the simulator (typical device frame ≈ 420px plus page/panel gutters);
  // smaller windows keep it closed so the device isn't squeezed on load.
  const [panelOpen, setPanelOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = Number(window.localStorage.getItem("serve-sim:tools-panel-width"));
    const panelWidth = Number.isFinite(stored) && stored > 0 ? stored : PANEL_WIDTH;
    return window.innerWidth >= panelWidth + 480;
  });
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
    const es = openHostEventStream(config.appStateEndpoint ?? simEndpoint("appstate"));
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
  const [deviceRenderedHeight, setDeviceRenderedHeight] = useState(0);
  useEffect(() => {
    const el = simContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      setDeviceRenderedWidth(rect?.width ?? 0);
      setDeviceRenderedHeight(rect?.height ?? 0);
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
      if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        if (type === "down" && !e.repeat) {
          rotateBy(e.code === "ArrowLeft" ? "left" : "right");
        }
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
  }, [sendWs, config.device, rotateBy]);

  const uploads = useUploadToasts();
  const screenshot = useScreenshotToast(config.device);
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
    onHostPathDrop: screenshot.dismiss,
  });

  const simulatorResize = useSimulatorResize({
    defaultWidth: containerDefaultWidth,
    viewportWidth,
    viewportHeight,
    aspectRatio: containerAspectRatioValue,
    onStart: () => setSimFocused(false),
  });

  // Only shift the simulator when a panel would otherwise collide with it.
  // Tools/DevTools dock on the right; the device sidebar docks on the left, so
  // each pushes the centered simulator the opposite way.
  const PANEL_EDGE_OFFSET = 12;
  const PANEL_GAP = 24;
  const deviceWidth = deviceRenderedWidth > 0
    ? Math.min(deviceRenderedWidth, simulatorResize.width)
    : simulatorResize.width;
  // Shift needed to clear a docked panel of `panelWidthPx` on the given side
  // without ever pushing the device under the opposite edge.
  const shiftToClear = (panelWidthPx: number): number => {
    if (panelWidthPx <= 0) return 0;
    const panelInnerEdge = viewportWidth - PANEL_EDGE_OFFSET - panelWidthPx;
    const deviceEdgeAtCenter = viewportWidth / 2 + deviceWidth / 2;
    const overlap = deviceEdgeAtCenter - (panelInnerEdge - PANEL_GAP);
    if (overlap <= 0) return 0;
    const shiftNeeded = 2 * overlap;
    return shiftNeeded <= panelWidthPx + PANEL_GAP ? shiftNeeded : 0;
  };
  const rightPanelWidthPx = devtoolsOpen
    ? devtoolsPanelWidth
    : panelOpen
    ? toolsPanelWidth
    : 0;
  const shiftForRightPanel = shiftToClear(rightPanelWidthPx);
  const shiftForLeftPanel = shiftToClear(gridOpen ? gridPanelWidth : 0);

  return (
    <AxStateProvider endpoint={axOverlayEnabled ? config?.axEndpoint : undefined}>
    <div
      className="flex flex-col items-center justify-center h-screen bg-page py-6 gap-3 font-system box-border"
      style={{
        paddingLeft: 24 + shiftForLeftPanel,
        paddingRight: 24 + shiftForRightPanel,
        transition:
          simulatorResize.isResizing || simulatorResize.isInertia ? "none" : SIMULATOR_RESIZE_PAGE_TRANSITION,
      }}
    >
      <div
        className="flex flex-col items-center gap-3 min-w-0"
        style={{
          width: simulatorResize.width,
          transition:
            simulatorResize.isResizing || simulatorResize.isInertia
              ? SIMULATOR_RESIZE_DRAG_TRANSITION
              : SIMULATOR_RESIZE_LAYOUT_TRANSITION,
        }}
      >
        <SimulatorToolbar
          exec={execOnHost}
          onRotate={rotateDevice}
          orientation={(activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? null}
          deviceUdid={config.device}
          deviceName={deviceName}
          deviceRuntime={deviceRuntime}
          streaming={streaming}
          aria-label="Simulator status"
          style={{
            alignSelf: "center",
            width: "auto",
            minWidth: 0,
            maxWidth: "100%",
            flexWrap: "nowrap",
            justifyContent: "center",
            gap: 10,
            padding: "6px 10px",
            borderRadius: 18,
          }}
        >
          <SimulatorToolbar.Title
            onClick={() => setGridOpen((o) => !o)}
            aria-label="Toggle simulators sidebar"
            aria-pressed={gridOpen}
            title="Simulators"
            hideSubtitle
            hideChevron
            style={{
              maxWidth: "min(230px, calc(100vw - 170px))",
            }}
          />
          <StreamStatusPill streaming={streaming} />
        </SimulatorToolbar>
        <div
          ref={simContainerRef}
          className="relative max-h-full"
          style={{
            width: simulatorResize.width,
            aspectRatio: containerAspectRatio,
            transition:
              simulatorResize.isResizing || simulatorResize.isInertia
                ? SIMULATOR_RESIZE_DRAG_TRANSITION
                : SIMULATOR_RESIZE_LAYOUT_TRANSITION,
            willChange:
              simulatorResize.isResizing || simulatorResize.isInertia ? "width" : undefined,
          }}
          {...mediaDrop.dropZoneProps}
        >
          {(() => {
            const streamView = (
              <SimulatorView
                url={config.url}
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  pointerEvents:
                    simulatorResize.isResizing || simulatorResize.isInertia ? "none" : undefined,
                }}
                imageStyle={{
                  // With chrome the screen slot clips (rounded) and the bezel
                  // provides the edge, so the stream itself is square + flush.
                  // Without chrome, round the screen and add a subtle bezel as an
                  // INSET shadow (not a border): a 1px border sits outside the
                  // content and, on the <canvas> path, composites its
                  // semi-transparent white against the black page as a visible
                  // outline. An inset shadow paints over the (opaque) video edge.
                  borderRadius: useChrome ? 0 : imgBorderRadius,
                  cornerShape: useChrome ? undefined : "superellipse(1.3)",
                  ...(useChrome
                    ? {}
                    : { boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.2)" }),
                } as CSSProperties}
                hideControls
                onStreamingChange={setStreaming}
                onStreamTouch={onStreamTouch}
                onStreamMultiTouch={onStreamMultiTouch}
                onStreamButton={onStreamButton}
                onStreamDigitalCrown={onStreamDigitalCrown}
                onStreamScroll={onStreamScroll}
                codec={useAvccVideo ? "avcc" : "mjpeg"}
                onAvccError={() => dispatchAvccFallback("error")}
                subscribeFrame={useAvccVideo ? undefined : mjpeg.subscribeFrame}
                streamFrame={useAvccVideo ? undefined : mjpeg.frame}
                streamConfig={activeStreamConfig}
                enableDigitalCrown={deviceType === "watch"}
                onScreenConfigChange={onScreenConfigChange}
              />
            );
            const screenContent = (
              <>
                {streamView}
                {axOverlayEnabled && <AxDomOverlay />}
              </>
            );
            if (!useChrome) return screenContent;
            // The screen slot is the bezel's true opening; the stream letterboxes
            // (contains) inside it, filling the constraining axis and leaving a
            // thin black margin on the other — the device's own black screen
            // border. Containing (not covering) keeps the stream from ever
            // overflowing past the bezel.
            return (
              <DeviceKitChrome
                chrome={chrome!}
                interactive
                onButton={handleChromeButton}
                onCrownWheel={(deltaY, deltaMode) => {
                  const delta = digitalCrownDeltaFromWheel(
                    deltaY,
                    deltaMode,
                    deviceRenderedHeight || 1,
                  );
                  if (delta != null) onStreamDigitalCrown(delta);
                }}
                screen={screenContent}
              />
            );
          })()}
          {mediaDrop.isDragOver && (
            <div
              // No backdrop-blur here: the canvas underneath repaints every
              // stream frame, and backdrop-filter forces a full re-blur per
              // frame for the whole drag — the tint alone stays cheap.
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-accent bg-[rgba(99,102,241,0.18)] text-accent pointer-events-none z-20"
              style={{ borderRadius: useChrome ? undefined : imgBorderRadius }}
            >
              <Upload size={32} strokeWidth={1.5} />
              <span className="text-[13px] font-medium">Drop media or .ipa</span>
            </div>
          )}
          <SimulatorResizeCornerHandle
            simulatorResize={simulatorResize}
            deviceType={deviceType}
            streamConfig={activeStreamConfig}
            containerWidth={deviceRenderedWidth || simulatorResize.width}
            containerHeight={
              deviceRenderedHeight ||
              (containerAspectRatioValue > 0 ? simulatorResize.width / containerAspectRatioValue : 0)
            }
          />
          <SimulatorResizeSizeBadge
            width={deviceRenderedWidth || simulatorResize.width}
            height={
              deviceRenderedHeight ||
              (containerAspectRatioValue > 0 ? simulatorResize.width / containerAspectRatioValue : 0)
            }
            visible={simulatorResize.isResizing || simulatorResize.isInertia}
          />
        </div>
        <div className="inline-flex items-center justify-center gap-2 max-w-full">
          <SimulatorToolbar
            exec={execOnHost}
            onRotate={rotateDevice}
            orientation={(activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? null}
            deviceUdid={config.device}
            deviceName={deviceName}
            deviceRuntime={deviceRuntime}
            streaming={streaming}
            aria-label="Simulator actions"
            style={{
              alignSelf: "center",
              width: "auto",
              minWidth: 0,
              maxWidth: "100%",
              justifyContent: "center",
              padding: "6px 8px",
              borderRadius: 18,
            }}
          >
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
              <SimulatorToolbar.HomeButton title="Home" />
              <SimulatorToolbar.ScreenshotButton
                title="Screenshot"
                onClick={(e) => { e.preventDefault(); void screenshot.capture(); }}
              />
              <SimulatorToolbar.RotateButton title="Rotate device" />
            </SimulatorToolbar.Actions>
          </SimulatorToolbar>
          <SimulatorToolbar
            exec={execOnHost}
            onRotate={rotateDevice}
            orientation={(activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? null}
            deviceUdid={config.device}
            deviceName={deviceName}
            deviceRuntime={deviceRuntime}
            streaming={streaming}
            aria-label="Accessibility overlay"
            style={{
              width: "auto",
              minWidth: 0,
              justifyContent: "center",
              padding: 6,
              borderRadius: 22,
            }}
          >
            <AxToolbarButton
              overlayEnabled={axOverlayEnabled}
              streaming={streaming}
              onToggleOverlay={() => setAxOverlayEnabled((enabled) => !enabled)}
            />
          </SimulatorToolbar>
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

      {/* Screenshot pill — macOS-style "saved" popup: click reveals in Finder,
          drag copies the file, and it animates out (timer pauses on hover). */}
      {screenshot.toast && (
        <ScreenshotToast
          toast={screenshot.toast}
          onReveal={screenshot.reveal}
          onDismiss={screenshot.dismiss}
          onPause={screenshot.pause}
          onResume={screenshot.resume}
        />
      )}

      {/* The left device sidebar + its rail live in App so they persist across
          stream swaps; AppWithConfig only renders the streaming-specific UI. */}

      {/* Right-edge rail: tools + WebKit DevTools. */}
      <div
        className={`fixed top-3 right-3 flex flex-col gap-1 p-1 bg-panel-bg border border-white/8 rounded-[10px] backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)] [transition:opacity_0.18s_ease] z-40 ${(panelOpen || devtoolsOpen) ? "opacity-0 pointer-events-none" : "opacity-100 pointer-events-auto"}`}
      >
        <button
          onClick={() => {
            setDevtoolsOpen(false);
            setPanelOpen((o) => !o);
          }}
          className="w-[30px] h-[30px] flex items-center justify-center bg-transparent border-none rounded-md text-[#8e8e93] cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
          aria-label="Open tools panel"
          aria-pressed={panelOpen}
          title="Tools"
        >
          <PanelRight size={18} strokeWidth={1.75} />
        </button>
        <button
          onClick={() => {
            setPanelOpen(false);
            setDevtoolsOpen((o) => !o);
          }}
          className="w-[30px] h-[30px] flex items-center justify-center bg-transparent border-none rounded-md text-[#8e8e93] cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
          aria-label="Open WebKit DevTools"
          aria-pressed={devtoolsOpen}
          title="WebKit DevTools"
        >
          <Globe size={18} strokeWidth={1.75} />
        </button>
      </div>

      <ToolsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        udid={config.device}
        deviceRuntime={deviceRuntime}
        currentApp={currentApp}
        axOverlayEnabled={axOverlayEnabled}
        onToggleAxOverlay={() => setAxOverlayEnabled((enabled) => !enabled)}
        codecPreference={codecPreference}
        onCodecPreferenceChange={setCodecPreference}
        activeCodec={useAvccVideo ? "h264" : "mjpeg"}
        avccSupported={avcc.supported}
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
    </div>
    </AxStateProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
