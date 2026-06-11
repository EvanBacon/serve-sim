export type DeviceLogLevel = "debug" | "info" | "default" | "error" | "fault" | "unknown";
export type DeviceLogStreamLevel = "debug" | "info" | "default";

export type DeviceLogEntry = {
  id: number;
  timestamp: string;
  level: DeviceLogLevel;
  process: string;
  processKey: string;
  processID?: number;
  subsystem: string;
  category: string;
  message: string;
  searchText: string;
  raw: Record<string, unknown>;
};

export type DeviceLogFilters = {
  search: string;
  levels: Set<DeviceLogLevel>;
  process: string;
  currentAppOnly: boolean;
  currentApp?: {
    bundleId: string;
    pid?: number;
    executable?: string | null;
  } | null;
};

const LOG_LEVELS: DeviceLogLevel[] = ["debug", "info", "default", "error", "fault", "unknown"];

export function normalizeLogLevel(value: unknown): DeviceLogLevel {
  const level = String(value ?? "").toLowerCase();
  if (LOG_LEVELS.includes(level as DeviceLogLevel)) return level as DeviceLogLevel;
  return "unknown";
}

export function parseDeviceLogEntry(rawValue: unknown, id: number): DeviceLogEntry | null {
  if (!rawValue || typeof rawValue !== "object") return null;
  const raw = rawValue as Record<string, unknown>;
  const message = String(raw.eventMessage ?? "");
  if (!message) return null;
  const processPath = String(raw.processImagePath ?? raw.senderImagePath ?? "");
  const process = processPath.split("/").filter(Boolean).pop() ?? String(raw.process ?? "");
  const processID = typeof raw.processID === "number" ? raw.processID : undefined;
  const timestamp = String(raw.timestamp ?? raw.machTimestamp ?? "");
  const level = normalizeLogLevel(raw.messageType);
  const subsystem = String(raw.subsystem ?? "");
  const category = String(raw.category ?? "");
  return {
    id,
    timestamp,
    level,
    process,
    processKey: process.toLowerCase(),
    processID,
    subsystem,
    category,
    message,
    searchText: [message, process, subsystem, category, level, timestamp]
      .join("\n")
      .toLowerCase(),
    raw,
  };
}

export function appendLogEntryBuffer(
  entries: DeviceLogEntry[],
  entry: DeviceLogEntry,
  limit: number,
): DeviceLogEntry[] {
  const next = entries.length >= limit ? entries.slice(entries.length - limit + 1) : entries.slice();
  next.push(entry);
  return next;
}

export function filterDeviceLogs(entries: DeviceLogEntry[], filters: DeviceLogFilters): DeviceLogEntry[] {
  const search = filters.search.trim().toLowerCase();
  const process = filters.process.trim().toLowerCase();
  return entries.filter((entry) => {
    if (!filters.levels.has(entry.level)) return false;
    if (process && entry.processKey !== process) return false;
    if (filters.currentAppOnly && !matchesCurrentApp(entry, filters.currentApp)) return false;
    return !search || entry.searchText.includes(search);
  });
}

export function matchesCurrentApp(
  entry: DeviceLogEntry,
  currentApp: DeviceLogFilters["currentApp"],
): boolean {
  if (!currentApp) return false;
  if (currentApp.pid != null && entry.processID === currentApp.pid) return true;
  if (currentApp.executable && entry.process === currentApp.executable) return true;
  return entry.searchText.includes(currentApp.bundleId.toLowerCase());
}

export function buildLogsEndpoint(endpoint: string, streamLevel: DeviceLogStreamLevel): string {
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set("level", streamLevel);
  return url.pathname + url.search + url.hash;
}
