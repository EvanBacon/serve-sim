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
