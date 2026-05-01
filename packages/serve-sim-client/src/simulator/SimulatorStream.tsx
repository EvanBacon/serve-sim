import { useState, useEffect, useRef, type CSSProperties } from "react";
import type { StreamAPI } from "../react.js";
import type { StreamConfig } from "../types.js";
import { SimulatorView } from "./SimulatorView.js";
import { useSimStream } from "./useSimStream.js";

export interface SimulatorStreamProps {
  /** Gateway exec function for running serve-sim CLI commands. */
  exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Device name or UDID to stream. When changed, the stream switches to the new device. */
  device?: string | null;
  style?: CSSProperties;
  /** Extra style applied to the <img> element rendering the stream (e.g. borderRadius). */
  imageStyle?: CSSProperties;
  className?: string;
  /** Stream API for relay mode (remote access). When provided, video/touch go through the relay. */
  stream?: StreamAPI;
  /** Hide the header bar (title + connect/disconnect buttons). Parent manages connect lifecycle. */
  headerless?: boolean;
  /** Called when streaming state changes (true = frames are flowing). */
  onStreamingChange?: (streaming: boolean) => void;
  /** Called when the stream reports new screen dimensions or orientation. */
  onScreenConfigChange?: (config: StreamConfig) => void;
  /** Called when an error occurs. When provided in headerless mode, the error is not rendered inline. */
  onError?: (error: string | null) => void;
  /** Called with the active serve-sim device UDID (or null when not streaming). */
  onActiveDeviceChange?: (udid: string | null) => void;
}

/**
 * Full serve-sim panel: connect/disconnect lifecycle + stream viewer.
 * Uses the gateway exec to invoke the `serve-sim` CLI on the host,
 * then connects directly to the serve-sim server for video + touch.
 */
export function SimulatorStream({ exec, device, style, imageStyle, className, stream, headerless, onStreamingChange, onScreenConfigChange, onError, onActiveDeviceChange }: SimulatorStreamProps) {
  const { info, loading, error, connect, disconnect, sendButton } = useSimStream({ exec, device });
  const [fullscreen, setFullscreen] = useState(false);
  const relayMode = !!stream;
  const prevInfo = useRef(info);

  // Bubble errors to parent when onError is provided.
  useEffect(() => {
    onError?.(error);
  }, [error, onError]);

  // Bubble the active serve-sim device UDID to parent.
  useEffect(() => {
    onActiveDeviceChange?.(info?.device ?? null);
  }, [info?.device, onActiveDeviceChange]);

  // When the hook auto-connects (info transitions null → non-null) in relay mode,
  // start the relay stream automatically.
  useEffect(() => {
    if (relayMode && info && !prevInfo.current) {
      stream.start({ maxFps: 30 });
    }
    prevInfo.current = info;
  }, [info, relayMode, stream]);

  const panel = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: info ? "transparent" : "black",
        ...(fullscreen ? fullscreenStyle : style),
      }}
      className={className}
    >
      {!headerless && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 12px",
            background: "rgba(255,255,255,0.04)",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#8b949e",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontFamily: "monospace",
            }}
          >
            Simulator
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            {info && (
              <button onClick={() => setFullscreen((v) => !v)} style={btnStyle}>
                {fullscreen ? "Exit" : "Fullscreen"}
              </button>
            )}
            {info ? (
              <button onClick={() => { if (relayMode) stream.stop(); disconnect(); }} disabled={loading} style={btnStyle}>
                {loading ? "..." : "Disconnect"}
              </button>
            ) : (
              <button onClick={async () => {
                console.log(`[serve-sim] Connect clicked`);
                const ok = await connect();
                console.log(`[serve-sim] connect() resolved (ok=${ok})`);
                if (ok && relayMode) {
                  console.log(`[serve-sim] sending stream:start`);
                  stream.start({ maxFps: 30 });
                }
              }} disabled={loading} style={btnStyle}>
                {loading ? "Connecting..." : "Connect"}
              </button>
            )}
          </div>
        </div>
      )}

      {error && !onError && (
        <div style={{ padding: "6px 12px", background: "#3d1111", color: "#f87171", fontSize: 11 }}>
          {error}
        </div>
      )}

      {info ? (
        <SimulatorView
          key={info.device}
          url={info.url}
          style={fullscreen ? { width: "100%", flex: 1 } : { width: "100%" }}
          imageStyle={imageStyle}
          onHomePress={() => relayMode ? stream.sendButton("home") : sendButton("home")}
          hideControls={headerless}
          onStreamingChange={onStreamingChange}
          onScreenConfigChange={onScreenConfigChange}
          connectionQuality={relayMode ? stream.connectionQuality ?? undefined : undefined}
          {...(relayMode ? {
            onStreamTouch: stream.sendTouch,
            onStreamMultiTouch: stream.sendMultiTouch,
            onStreamButton: stream.sendButton,
            subscribeFrame: stream.subscribeFrame,
            streamFrame: stream.frame,
            streamConfig: stream.config,
          } : {})}
        />
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            minHeight: 200,
            gap: 12,
          }}
        >
          {loading && (
            <span style={{ color: "#484f58", fontSize: 12, textAlign: "center", lineHeight: 1.6 }}>
              Starting simulator...
            </span>
          )}
          {!loading && (
            <button
              aria-label="Power on"
              onClick={async () => {
                const ok = await connect();
                if (ok && relayMode) stream.start({ maxFps: 30 });
              }}
              style={{
                background: "transparent",
                border: "none",
                padding: 8,
                cursor: "pointer",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2v10" />
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );

  return panel;
}

const fullscreenStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  background: "#0d1117",
  display: "flex",
  flexDirection: "column",
};

const btnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "none",
  color: "#58a6ff",
  borderRadius: 6,
  padding: "4px 12px",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "monospace",
};
