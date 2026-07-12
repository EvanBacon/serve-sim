import type { EventLogEntry } from "./event-log";

export function formatEventLogLine(
  entry: EventLogEntry,
  options: { deviceLabel?: string | null } = {},
): string {
  const time = new Date(entry.timestamp);
  const stamp = Number.isNaN(time.getTime())
    ? entry.timestamp
    : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const device = options.deviceLabel ?? (entry.device ? entry.device.slice(0, 8) : null);
  const status = entry.status === "error" ? " failed" : "";
  return [stamp, device, `${humanEventLogSummary(entry)}${status ? ` (${status.trim()})` : ""}`]
    .filter(Boolean)
    .join("  ");
}

export function humanEventLogSummary(entry: EventLogEntry): string {
  if (entry.kind === "tap") {
    const point = pointFromDetails(entry.details, "current") ?? pointFromDetails(entry.details, "start");
    return point ? `Tap at ${formatNormalizedPoint(point)}` : "Tap";
  }
  if (entry.kind === "drag") {
    const start = pointFromDetails(entry.details, "start");
    const current = pointFromDetails(entry.details, "current");
    if (start && current) {
      return `Drag from ${formatNormalizedPoint(start)} to ${formatNormalizedPoint(current)}`;
    }
    return "Drag";
  }
  if (entry.kind === "key") {
    const key = stringDetail(entry.details, "key") ?? entry.action ?? "key";
    const action = entry.action === "down" ? "down" : entry.action === "up" ? "up" : entry.action;
    return action ? `Key ${action} ${humanizeKey(key)}` : `Key ${humanizeKey(key)}`;
  }
  if (entry.kind === "rotate") {
    const orientation = entry.action ? humanizeToken(entry.action) : "";
    return orientation ? `Rotate ${orientation}` : "Rotate";
  }
  return humanizeSummary(entry.msg ?? entry.summary);
}

function pointFromDetails(
  details: Record<string, unknown> | undefined,
  key: "start" | "current",
): { x: number; y: number } | null {
  const value = details?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number"
    ? { x: point.x, y: point.y }
    : null;
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatNormalizedPoint(point: { x: number; y: number }): string {
  return `${formatNormalized(point.x)}, ${formatNormalized(point.y)}`;
}

function formatNormalized(value: number): string {
  if (!Number.isFinite(value)) return "?";
  return (Math.round((clamp(value, 0, 1) + Number.EPSILON) * 100) / 100).toFixed(2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function humanizeSummary(summary: string): string {
  return summary.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, humanizeToken);
}

function humanizeToken(value: string): string {
  return value.replace(/[-_]+/g, " ");
}

function humanizeKey(value: string): string {
  const labels: Record<string, string> = {
    MetaLeft: "Left Command",
    MetaRight: "Right Command",
    AltLeft: "Left Option",
    AltRight: "Right Option",
    ControlLeft: "Left Control",
    ControlRight: "Right Control",
    ShiftLeft: "Left Shift",
    ShiftRight: "Right Shift",
    ArrowLeft: "Left Arrow",
    ArrowRight: "Right Arrow",
    ArrowUp: "Up Arrow",
    ArrowDown: "Down Arrow",
  };
  return labels[value] ?? value;
}
