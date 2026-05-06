import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";

interface HelperInfo {
  port: number;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

interface GridDevice {
  device: string;
  name: string;
  runtime: string;
  state: string;
  helper: HelperInfo | null;
}

interface GridConfig {
  basePath: string;
  apiEndpoint: string;
  startEndpoint: string;
  shutdownEndpoint: string;
  memoryEndpoint: string;
  previewEndpoint: string;
}

interface MemoryReport {
  totalBytes: number;
  availableBytes: number;
  runningSimulators: number;
  perSimAvgBytes: number;
  perSimSource: "measured" | "estimated";
  estimatedAdditional: number;
}

declare global {
  interface Window {
    __SIM_GRID__?: GridConfig;
  }
}

const config: GridConfig = window.__SIM_GRID__ ?? {
  basePath: "/",
  apiEndpoint: "/grid/api",
  startEndpoint: "/grid/api/start",
  shutdownEndpoint: "/grid/api/shutdown",
  memoryEndpoint: "/grid/api/memory",
  previewEndpoint: "/",
};

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function useMemory() {
  const [report, setReport] = useState<MemoryReport | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(config.memoryEndpoint, { cache: "no-store" });
        const json = (await res.json()) as MemoryReport;
        if (!cancelled) setReport(json);
      } catch {
        // leave previous report visible on transient failures
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return report;
}

function CapacityBanner({ report }: { report: MemoryReport | null }) {
  if (!report || report.totalBytes === 0) return null;
  const { estimatedAdditional, availableBytes, totalBytes, perSimAvgBytes, perSimSource, runningSimulators } = report;
  const usedFraction = Math.max(0, Math.min(1, 1 - availableBytes / totalBytes));
  const headlineColor =
    estimatedAdditional === 0 ? "#e66" : estimatedAdditional <= 1 ? "#e9a13b" : "#9c9";
  const headline =
    estimatedAdditional === 0
      ? "No room for another simulator"
      : `~${estimatedAdditional} more simulator${estimatedAdditional === 1 ? "" : "s"} fit in memory`;
  const detail = `${formatBytes(availableBytes)} free of ${formatBytes(totalBytes)} · ${
    perSimSource === "measured"
      ? `~${formatBytes(perSimAvgBytes)}/sim across ${runningSimulators} running`
      : `~${formatBytes(perSimAvgBytes)}/sim (default estimate)`
  }`;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 16px",
        margin: "16px 16px 0",
        borderRadius: 10,
        background: "#101010",
        border: "1px solid #222",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <span style={{ color: headlineColor, fontSize: 13, fontWeight: 600 }}>{headline}</span>
        <span style={{ color: "#888", fontSize: 11 }}>{detail}</span>
      </div>
      <div
        style={{
          height: 4,
          width: "100%",
          background: "#1c1c1c",
          borderRadius: 2,
          overflow: "hidden",
        }}
        title={`${(usedFraction * 100).toFixed(0)}% used`}
      >
        <div
          style={{
            width: `${(usedFraction * 100).toFixed(1)}%`,
            height: "100%",
            background:
              usedFraction > 0.9 ? "#e66" : usedFraction > 0.75 ? "#e9a13b" : "#3b3",
            transition: "width 300ms ease, background 300ms ease",
          }}
        />
      </div>
    </div>
  );
}

function previewHrefFor(udid: string): string {
  const sep = config.previewEndpoint.includes("?") ? "&" : "?";
  return `${config.previewEndpoint}${sep}device=${encodeURIComponent(udid)}`;
}

function useDevices() {
  const [devices, setDevices] = useState<GridDevice[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(config.apiEndpoint, { cache: "no-store" });
        const json = await res.json();
        if (!cancelled) setDevices(json.devices ?? []);
      } catch {
        if (!cancelled) setDevices([]);
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  return { devices, refresh };
}

/**
 * Hover-revealed close button. Stays interactive (pointer-events: auto) even
 * when the surrounding tile sets pointerEvents:none on its inner content.
 */
function ShutdownButton({
  onClick,
  pending,
}: {
  onClick: (e: any) => void;
  pending: boolean;
}) {
  return (
    <button
      type="button"
      title={pending ? "Shutting down…" : "Shutdown simulator"}
      aria-label="Shutdown simulator"
      onClick={onClick}
      disabled={pending}
      className="grid-shutdown-btn"
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        width: 24,
        height: 24,
        borderRadius: 12,
        border: "1px solid #444",
        background: "rgba(20,20,20,0.85)",
        color: pending ? "#666" : "#ccc",
        fontSize: 14,
        lineHeight: 1,
        cursor: pending ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        zIndex: 2,
        pointerEvents: "auto",
      }}
    >
      ×
    </button>
  );
}

function ActiveTile({
  device,
  onShutdown,
  shuttingDown,
}: {
  device: GridDevice;
  onShutdown: () => void;
  shuttingDown: boolean;
}) {
  const helper = device.helper!;
  return (
    <a
      href={previewHrefFor(device.device)}
      className="grid-tile"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        background: "#111",
        borderRadius: 12,
        overflow: "hidden",
        textDecoration: "none",
        color: "inherit",
        border: "1px solid #2a2a2a",
        transition: "border-color 120ms",
      }}
    >
      <ShutdownButton
        pending={shuttingDown}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onShutdown();
        }}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 12,
          background: "#000",
          pointerEvents: "none",
        }}
      >
        <img
          src={helper.streamUrl}
          alt={device.name}
          draggable={false}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
        />
      </div>
      <TileFooter device={device} status="● live" statusColor="#3b3" port={helper.port} />
    </a>
  );
}

function InactiveTile({
  device,
  onStart,
  onShutdown,
  starting,
  shuttingDown,
  error,
}: {
  device: GridDevice;
  onStart: () => void;
  onShutdown: () => void;
  starting: boolean;
  shuttingDown: boolean;
  error: string | null;
}) {
  const isBooted = device.state === "Booted";
  const status = starting
    ? isBooted ? "starting helper…" : "booting & starting…"
    : shuttingDown
    ? "shutting down…"
    : isBooted ? "booted (no stream)" : device.state.toLowerCase();
  return (
    <div
      className="grid-tile"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        background: "#0d0d0d",
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid #1f1f1f",
      }}
    >
      {isBooted ? (
        <ShutdownButton pending={shuttingDown} onClick={onShutdown} />
      ) : null}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          flexDirection: "column",
          gap: 12,
          color: "#666",
          fontSize: 13,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 36, opacity: 0.5 }}>{isBooted ? "▣" : "▢"}</div>
        {error ? (
          <div style={{ color: "#e66", fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
            {error}
          </div>
        ) : null}
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid #333",
            background: starting ? "#1a1a1a" : "#1d2a1d",
            color: starting ? "#666" : "#9c9",
            cursor: starting ? "default" : "pointer",
            fontSize: 12,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {isBooted ? "Start stream" : "Boot & start"}
        </button>
      </div>
      <TileFooter device={device} status={status} statusColor="#888" />
    </div>
  );
}

function TileFooter({
  device,
  status,
  statusColor,
  port,
}: {
  device: GridDevice;
  status: string;
  statusColor: string;
  port?: number;
}) {
  return (
    <div
      style={{
        padding: "8px 12px",
        borderTop: "1px solid #222",
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#bbb",
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {device.name}
      </span>
      <span style={{ color: statusColor, whiteSpace: "nowrap" }}>
        {status}
        {port !== undefined ? <span style={{ color: "#666" }}> :{port}</span> : null}
      </span>
    </div>
  );
}

function Empty() {
  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        color: "#888",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
      }}
    >
      No iOS simulators available.
    </div>
  );
}

const HOVER_CSS = `
  .grid-shutdown-btn { opacity: 0; transition: opacity 120ms, background 120ms, color 120ms; }
  .grid-tile:hover .grid-shutdown-btn { opacity: 1; }
  .grid-shutdown-btn:hover:not(:disabled) { background: #5a1d1d; color: #fff; border-color: #a33; }
  .grid-tile:hover { border-color: #555 !important; }
`;

function App() {
  const { devices, refresh } = useDevices();
  const memory = useMemory();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [shuttingDown, setShuttingDown] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const start = useCallback(
    async (udid: string) => {
      setPending((p) => ({ ...p, [udid]: true }));
      setErrors((e) => ({ ...e, [udid]: null }));
      try {
        const res = await fetch(config.startEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udid }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          setErrors((e) => ({ ...e, [udid]: json.error ?? `HTTP ${res.status}` }));
        }
      } catch (err: any) {
        setErrors((e) => ({ ...e, [udid]: err?.message ?? "Request failed" }));
      } finally {
        setPending((p) => ({ ...p, [udid]: false }));
        refresh();
      }
    },
    [refresh],
  );

  const shutdown = useCallback(
    async (udid: string) => {
      setShuttingDown((s) => ({ ...s, [udid]: true }));
      setErrors((e) => ({ ...e, [udid]: null }));
      try {
        const res = await fetch(config.shutdownEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udid }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          setErrors((e) => ({ ...e, [udid]: json.error ?? `HTTP ${res.status}` }));
        }
      } catch (err: any) {
        setErrors((e) => ({ ...e, [udid]: err?.message ?? "Request failed" }));
      } finally {
        setShuttingDown((s) => ({ ...s, [udid]: false }));
        refresh();
      }
    },
    [refresh],
  );

  if (devices === null) return null;
  if (devices.length === 0) return <Empty />;
  return (
    <>
      <style>{HOVER_CSS}</style>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: 0,
        }}
      >
      <CapacityBanner report={memory} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gridAutoRows: "minmax(420px, auto)",
          gap: 16,
          padding: 16,
          flex: 1,
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {devices.map((d) =>
          d.helper ? (
            <ActiveTile
              key={d.device}
              device={d}
              shuttingDown={!!shuttingDown[d.device]}
              onShutdown={() => shutdown(d.device)}
            />
          ) : (
            <InactiveTile
              key={d.device}
              device={d}
              starting={!!pending[d.device]}
              shuttingDown={!!shuttingDown[d.device]}
              error={errors[d.device] ?? null}
              onStart={() => start(d.device)}
              onShutdown={() => shutdown(d.device)}
            />
          ),
        )}
      </div>
      </div>
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
