import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Gateway from "./gateway";
import type { ConnectOptions, GatewayShell, ShellResult } from "./gateway";
import { fetchGatewayStatus } from "./discovery";
import type { GatewayStatus, DiscoverOptions } from "./discovery";
import type { AdaptiveState, ConnectionQuality } from "./transport";

export type { GatewayStatus, DiscoverOptions } from "./discovery";
export { fetchGatewayStatus } from "./discovery";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface UseGatewayOptions extends ConnectOptions {}

export interface HistoryEntry {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface StreamAPI {
  start: (options?: { maxFps?: number }) => void;
  stop: () => void;
  sendTouch: (data: { type: "begin" | "move" | "end"; x: number; y: number; edge?: number }) => void;
  sendMultiTouch: (data: { type: "begin" | "move" | "end"; x1: number; y1: number; x2: number; y2: number }) => void;
  sendButton: (button: string) => void;
  /** Subscribe to frame updates (bypasses React state for performance). Returns unsubscribe fn.
   * Callback receives a blob URL (object URL) pointing to the JPEG frame. */
  subscribeFrame: (cb: (blobUrl: string) => void) => () => void;
  frame: string | null;
  config: { width: number; height: number } | null;
  /** Current adaptive FPS (may change dynamically based on network conditions). */
  adaptiveFps: number;
  /** Adaptive state: "normal" when at full FPS, "degraded" when reduced. */
  adaptiveState: AdaptiveState;
  connectionQuality: ConnectionQuality | null;
}

export interface UseGatewayResult {
  status: ConnectionStatus;
  error: string | null;
  exec: (command: string) => Promise<ShellResult>;
  history: HistoryEntry[];
  clearHistory: () => void;
  stream: StreamAPI;
}

export function useGateway(options: UseGatewayOptions): UseGatewayResult {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const streamFrameRef = useRef<string | null>(null);
  const frameListenersRef = useRef(new Set<(blobUrl: string) => void>());
  const [streamConfig, setStreamConfig] = useState<{ width: number; height: number } | null>(null);
  const [adaptiveFps, setAdaptiveFps] = useState(30);
  const [adaptiveState, setAdaptiveState] = useState<AdaptiveState>("normal");
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  const shellRef = useRef<GatewayShell | null>(null);

  const { url, token, bridgedCommands } = options;

  // Reconnect when the tab/window becomes visible again
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setReconnectKey((k) => k + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!url) {
      setStatus("disconnected");
      return;
    }
    let cancelled = false;
    setStatus("connecting");
    setError(null);

    Gateway.connect({ url, token, bridgedCommands })
      .then(($) => {
        if (cancelled) {
          $.close();
          return;
        }
        shellRef.current = $;

        // Register stream listeners (frames bypass React state for performance)
        $.transport.onStreamFrame((blobUrl) => {
          if (cancelled) return;
          streamFrameRef.current = blobUrl;
          for (const cb of frameListenersRef.current) cb(blobUrl);
        });
        $.transport.onStreamConfig((config) => {
          if (!cancelled) setStreamConfig(config);
        });
        $.transport.onAdaptiveFps((fps, state) => {
          if (cancelled) return;
          setAdaptiveFps(fps);
          setAdaptiveState(state);
        });
        $.transport.onConnectionQualityChange((quality) => {
          if (!cancelled) setConnectionQuality(quality);
        });

        setStatus("connected");
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "Connection failed");
      });

    return () => {
      cancelled = true;
      shellRef.current?.close();
      shellRef.current = null;
      setStatus("disconnected");
      streamFrameRef.current = null;
      setStreamConfig(null);
      setAdaptiveFps(30);
      setAdaptiveState("normal");
      setConnectionQuality(null);
    };
  }, [url, token, bridgedCommands?.join(","), reconnectKey]);

  const exec = useCallback(async (command: string): Promise<ShellResult> => {
    const $ = shellRef.current;
    if (!$) {
      throw new Error(
        "Gateway not connected. Start the gateway server on your Mac.",
      );
    }
    const result = await $.exec(command);
    setHistory((prev) => [
      ...prev,
      {
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
    ]);
    return result;
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  const subscribeFrame = useCallback((cb: (blobUrl: string) => void) => {
    frameListenersRef.current.add(cb);
    // Send current frame immediately if available
    if (streamFrameRef.current) cb(streamFrameRef.current);
    return () => { frameListenersRef.current.delete(cb); };
  }, []);

  const stream: StreamAPI = useMemo(() => ({
    start: (options) => shellRef.current?.transport.streamStart(options),
    stop: () => shellRef.current?.transport.streamStop(),
    sendTouch: (data) => shellRef.current?.transport.streamTouch(data),
    sendMultiTouch: (data) => shellRef.current?.transport.streamMultiTouch(data),
    sendButton: (button) => shellRef.current?.transport.streamButton(button),
    subscribeFrame,
    get frame() { return streamFrameRef.current; },
    config: streamConfig,
    adaptiveFps,
    adaptiveState,
    connectionQuality,
  }), [streamConfig, subscribeFrame, adaptiveFps, adaptiveState, connectionQuality]);

  return { status, error, exec, history, clearHistory, stream };
}

export interface UseGatewayStatusOptions extends DiscoverOptions {
  /** Polling interval in ms (default: 3000). Set to 0 to disable polling. */
  pollInterval?: number;
}

export interface UseGatewayStatusResult {
  /** The latest status response, or null if unreachable. */
  gatewayStatus: GatewayStatus | null;
  /** Whether a fetch is currently in-flight. */
  loading: boolean;
  /** Manually refresh the status. */
  refresh: () => void;
}

/**
 * Poll a gateway's `/status` endpoint to detect whether it's running.
 */
export function useGatewayStatus(
  options: UseGatewayStatusOptions = {}
): UseGatewayStatusResult {
  const { baseUrl, timeout, pollInterval = 3000 } = options;
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchOpts = useRef({ baseUrl, timeout });
  fetchOpts.current = { baseUrl, timeout };

  const doFetch = useCallback(async () => {
    setLoading(true);
    const result = await fetchGatewayStatus(fetchOpts.current);
    setGatewayStatus(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    doFetch();
    if (pollInterval <= 0) return;
    const id = setInterval(doFetch, pollInterval);
    return () => clearInterval(id);
  }, [doFetch, pollInterval]);

  return { gatewayStatus, loading, refresh: doFetch };
}
