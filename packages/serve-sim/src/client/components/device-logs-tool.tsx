import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useDeviceLogs } from "../hooks/use-device-logs";
import { fetchAppDetails } from "../utils/app-icon";
import { execOnHost } from "../utils/exec";
import {
  filterDeviceLogs,
  type DeviceLogEntry,
  type DeviceLogLevel,
  type DeviceLogStreamLevel,
} from "../utils/logs";

const LEVELS: DeviceLogLevel[] = ["debug", "info", "default", "error", "fault"];
const STREAM_LEVELS: DeviceLogStreamLevel[] = ["info", "debug", "default"];

export function DeviceLogsTool({
  udid,
  currentApp,
  logsEndpoint,
}: {
  udid: string;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
  logsEndpoint?: string;
}) {
  const [paused, setPaused] = useState(false);
  const [followTail, setFollowTail] = useState(true);
  const [search, setSearch] = useState("");
  const [process, setProcess] = useState("");
  const [streamLevel, setStreamLevel] = useState<DeviceLogStreamLevel>("info");
  const [levels, setLevels] = useState<Set<DeviceLogLevel>>(() => new Set(["info", "default", "error", "fault"]));
  const [currentAppOnly, setCurrentAppOnly] = useState(false);
  const [appExecutable, setAppExecutable] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const deferredSearch = useDeferredValue(search);
  const currentBundleId = currentApp?.bundleId ?? null;
  const currentPid = currentApp?.pid;
  const canScopeToCurrentApp = Boolean(currentBundleId && currentBundleId !== "com.apple.springboard");

  const { entries, status, error, clear } = useDeviceLogs({
    endpoint: logsEndpoint,
    enabled: !paused,
    streamLevel,
  });

  useEffect(() => {
    const bundleId = currentBundleId;
    setCurrentAppOnly(false);
    setProcess("");
    setAppExecutable(null);
    if (!bundleId) return;
    let cancelled = false;
    fetchAppDetails(execOnHost, udid, bundleId).then((details) => {
      if (!cancelled) setAppExecutable(details.executable ?? null);
    }).catch(() => {
      if (!cancelled) setAppExecutable(null);
    });
    return () => { cancelled = true; };
  }, [udid, currentBundleId]);

  const processOptions = useMemo(() => {
    const names = new Set<string>();
    for (const entry of entries) {
      if (entry.process) names.add(entry.process);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const currentAppFilter = useMemo(() => currentBundleId ? {
    bundleId: currentBundleId,
    pid: currentPid,
    executable: appExecutable,
  } : null, [currentBundleId, currentPid, appExecutable]);

  const visible = useMemo(() => filterDeviceLogs(entries, {
    search: deferredSearch,
    levels,
    process,
    currentAppOnly,
    currentApp: currentAppFilter,
  }), [entries, deferredSearch, levels, process, currentAppOnly, currentAppFilter]);

  useEffect(() => {
    if (!followTail) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [visible.length, followTail]);

  const toggleLevel = (level: DeviceLogLevel) => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      if (next.size === 0) next.add(level);
      return next;
    });
  };

  const exportVisible = () => {
    const body = visible.map((entry) => JSON.stringify(entry.raw)).join("\n");
    const blob = new Blob([body], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `serve-sim-${udid}-logs.ndjson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-0 flex-1 flex flex-col gap-2.5">
      <div className="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 min-h-[24px] leading-none">
        <DeviceLogsStatusLabel status={paused ? "paused" : status} />
      </div>

      <div className="grid grid-cols-[1fr_auto_auto] gap-1.5">
        <input
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="Search logs"
          className="min-w-0 h-7 rounded-md border border-white/10 bg-panel-deep px-2 text-[12px] text-white/90 outline-none placeholder:text-white/35"
        />
        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          className="h-7 rounded-md border border-white/12 bg-white/[0.03] px-2 text-[10px] text-white/75 cursor-pointer"
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={clear}
          className="h-7 rounded-md border border-white/12 bg-white/[0.03] px-2 text-[10px] text-white/75 cursor-pointer"
        >
          Clear
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <select
          value={process}
          onChange={(event) => setProcess(event.currentTarget.value)}
          className="min-w-0 h-7 rounded-md border border-white/10 bg-panel-deep px-2 text-[11px] text-white/80 outline-none"
          title="Process filter"
        >
          <option value="">All processes</option>
          {processOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select
          value={streamLevel}
          onChange={(event) => setStreamLevel(event.currentTarget.value as DeviceLogStreamLevel)}
          className="min-w-0 h-7 rounded-md border border-white/10 bg-panel-deep px-2 text-[11px] text-white/80 outline-none"
          title="Stream verbosity"
        >
          {STREAM_LEVELS.map((level) => <option key={level} value={level}>Stream {level}</option>)}
        </select>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => toggleLevel(level)}
            aria-pressed={levels.has(level)}
            className={`rounded-md border px-2 py-1 text-[10px] uppercase tracking-[0.03em] cursor-pointer ${levels.has(level) ? levelClass(level) : "border-white/10 bg-transparent text-white/45"}`}
          >
            {level}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-[11px] text-white/55">
        <label className="inline-flex items-center gap-1.5 min-w-0">
          <input
            type="checkbox"
            checked={currentAppOnly}
            disabled={!canScopeToCurrentApp}
            onChange={(event) => setCurrentAppOnly(event.currentTarget.checked)}
            className="m-0"
          />
          <span className="truncate">{canScopeToCurrentApp ? "Current app" : "All device"}</span>
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={followTail}
            onChange={(event) => setFollowTail(event.currentTarget.checked)}
            className="m-0"
          />
          Follow
        </label>
        <button
          type="button"
          onClick={exportVisible}
          disabled={visible.length === 0}
          className="rounded-md border border-white/12 bg-transparent px-2 py-1 text-[10px] text-white/70 cursor-pointer disabled:cursor-default disabled:text-white/30"
        >
          Export
        </button>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md">
          {error}
        </div>
      )}

      <div className="flex-1 rounded-lg border border-white/8 bg-panel-deep overflow-hidden min-h-0 flex flex-col">
        <div className="grid grid-cols-[54px_52px_82px_1fr] gap-2 border-b border-white/8 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-white/45">
          <span>Time</span>
          <span>Level</span>
          <span>Process</span>
          <span>Message</span>
        </div>
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:thin]">
          {visible.length === 0 ? (
            <div className="p-5 text-center text-[12px] text-white/45">
              {entries.length === 0 ? (paused ? "Log stream is paused." : "Waiting for device logs…") : "No logs match the current filters."}
            </div>
          ) : visible.map((entry) => (
            <LogRow
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={() => setExpandedId((value) => value === entry.id ? null : entry.id)}
            />
          ))}
        </div>
      </div>

      <div className="flex justify-between gap-2 text-[10px] text-white/45 font-mono">
        <span>{visible.length}/{entries.length} rows</span>
        <span>{currentAppOnly && appExecutable ? appExecutable : udid.slice(0, 8)}</span>
      </div>
    </div>
  );
}

function DeviceLogsStatusLabel({ status }: { status: "idle" | "connecting" | "live" | "error" | "paused" }) {
  return (
    <>
      <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">Device Logs</span>
      <span />
      <span className="inline-flex items-center gap-1.5 text-[10px] text-white/55 font-mono">
        <span className={`w-1.5 h-1.5 rounded-full ${status === "live" ? "bg-success" : status === "error" ? "bg-danger" : status === "paused" ? "bg-warning" : "bg-white/35"}`} />
        {status}
      </span>
    </>
  );
}

const LogRow = memo(function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: DeviceLogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const copy = async () => {
    await navigator.clipboard?.writeText(JSON.stringify(entry.raw, null, 2));
  };
  return (
    <div className="border-b border-white/[0.04] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-[54px_52px_82px_1fr] gap-2 border-none bg-transparent px-2 py-1.5 text-left text-[11px] text-white/80 cursor-pointer hover:bg-white/[0.04]"
      >
        <span className="font-mono text-white/45 truncate">{formatTime(entry.timestamp)}</span>
        <span className={`w-fit rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.03em] ${levelClass(entry.level)}`}>{entry.level}</span>
        <span className="font-mono text-white/55 truncate" title={entry.process}>{entry.process || "—"}</span>
        <span className="min-w-0 truncate" title={entry.message}>{entry.message}</span>
      </button>
      {expanded && (
        <div className="border-t border-white/[0.04] bg-black/20 px-2 py-2">
          <div className="flex items-center justify-between gap-2 pb-1.5">
            <span className="min-w-0 truncate text-[10px] text-white/45">
              {[entry.subsystem, entry.category].filter(Boolean).join(" · ") || "No subsystem"}
            </span>
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-white/12 bg-transparent px-2 py-1 text-[10px] text-white/70 cursor-pointer"
            >
              Copy
            </button>
          </div>
          <pre className="m-0 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 p-2 font-mono text-[10px] leading-4 text-white/65 [scrollbar-width:thin]">{JSON.stringify(entry.raw, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}, (prev, next) => prev.entry === next.entry && prev.expanded === next.expanded);

function levelClass(level: DeviceLogLevel): string {
  if (level === "fault") return "border-danger/30 bg-danger/18 text-danger-soft";
  if (level === "error") return "border-danger/25 bg-danger/12 text-danger-soft";
  if (level === "debug") return "border-accent/25 bg-accent/12 text-accent";
  if (level === "info") return "border-success/25 bg-success/12 text-success";
  return "border-white/12 bg-white/[0.06] text-white/70";
}

function formatTime(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(11, 19) || value.slice(0, 8);
  return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
