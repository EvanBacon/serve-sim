export interface GridDevice {
  device: string;
  name: string;
  runtime: string;
  state: string;
  helper: { port: number; url: string; streamUrl: string; wsUrl: string } | null;
}

export interface MemoryReport {
  totalBytes: number;
  availableBytes: number;
  runningSimulators: number;
  perSimAvgBytes: number;
  perSimSource: "measured" | "estimated";
  estimatedAdditional: number;
}

export function formatGridBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

export function gridPreviewHref(previewEndpoint: string, udid: string): string {
  const sep = previewEndpoint.includes("?") ? "&" : "?";
  return `${previewEndpoint}${sep}device=${encodeURIComponent(udid)}`;
}

// Grid runtimes arrive as `iOS-26-5` / `watchOS-11-2` (simctl's SimRuntime
// suffix). Split the OS name from its dotted version for display.
export function parseRuntime(runtime: string): { os: string; version: string } {
  const m = runtime.match(/^([a-zA-Z]+)-(.+)$/);
  if (!m) return { os: runtime, version: "" };
  return { os: m[1]!, version: m[2]!.replace(/-/g, ".") };
}

/** Just the dotted version, e.g. `26.5`. */
export function runtimeVersion(runtime: string): string {
  return parseRuntime(runtime).version || runtime;
}

/** Human label, e.g. `iOS 26.5`. */
export function runtimeLabel(runtime: string): string {
  const { os, version } = parseRuntime(runtime);
  return version ? `${os} ${version}` : os;
}
