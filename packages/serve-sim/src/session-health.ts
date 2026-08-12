export type SessionPhase = "unstarted" | "starting" | "running" | "failed" | "stopped";
export type SessionHealthStatus = "starting" | "ok" | "stalled" | "failed" | "stopped";
export type StreamCodec = "mjpeg" | "avcc";

export type SessionClientCounts = {
  mjpeg: number;
  avcc: number;
  hid: number;
};

export type SessionHealthSnapshot = {
  status: SessionHealthStatus;
  ready: boolean;
  device: string;
  phase: SessionPhase;
  startedAt: string | null;
  checkedAt: string;
  uptimeMs: number | null;
  screen: { width: number; height: number; orientation: string } | null;
  clients: SessionClientCounts & { total: number };
  frames: {
    mjpeg: number;
    avcc: number;
    lastAt: string | null;
    lastCodec: StreamCodec | null;
    staleForMs: number | null;
  };
  error: { message: string; at: string } | null;
};

type SessionHealthOptions = {
  now?: () => number;
  startupTimeoutMs?: number;
  staleAfterMs?: number;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_AFTER_MS = 3_000;

/**
 * Small, deterministic state tracker for the native capture pipeline.
 *
 * The native framebuffer has a 5fps idle floor, so a running session that has
 * not produced a frame within the stale window is genuinely unhealthy even
 * when the simulator screen is static.
 */
export class SessionHealth {
  private readonly now: () => number;
  private readonly startupTimeoutMs: number;
  private readonly staleAfterMs: number;

  private phase: SessionPhase = "unstarted";
  private startedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private lastCodec: StreamCodec | null = null;
  private width = 0;
  private height = 0;
  private mjpegFrames = 0;
  private avccFrames = 0;
  private error: { message: string; at: number } | null = null;

  constructor(
    private readonly device: string,
    options: SessionHealthOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  markStarting(): void {
    if (this.phase === "stopped") return;
    if (this.phase === "failed") {
      this.startedAt = this.now();
      this.lastFrameAt = null;
      this.lastCodec = null;
    } else if (this.startedAt === null) {
      this.startedAt = this.now();
    }
    this.phase = "starting";
    this.error = null;
  }

  markRunning(): void {
    if (this.phase === "stopped") return;
    if (this.startedAt === null) this.startedAt = this.now();
    this.phase = "running";
    this.error = null;
  }

  recordFrame(codec: StreamCodec, screen: { width: number; height: number }): void {
    if (this.phase !== "starting" && this.phase !== "running") return;
    if (codec === "mjpeg") this.mjpegFrames++;
    else this.avccFrames++;
    this.lastFrameAt = this.now();
    this.lastCodec = codec;
    this.width = screen.width;
    this.height = screen.height;
  }

  markFailed(error: unknown): void {
    if (this.phase === "stopped") return;
    const at = this.now();
    this.phase = "failed";
    this.error = {
      message: error instanceof Error ? error.message : String(error),
      at,
    };
  }

  markStopped(): void {
    this.phase = "stopped";
  }

  httpStatus(status = this.currentStatus(this.now())): number {
    switch (status) {
      case "ok": return 200;
      case "starting": return 425;
      case "stalled":
      case "failed":
      case "stopped": return 503;
    }
  }

  snapshot(clients: SessionClientCounts, orientation = "portrait"): SessionHealthSnapshot {
    const now = this.now();
    const status = this.currentStatus(now);
    const staleForMs = this.lastFrameAt === null ? null : Math.max(0, now - this.lastFrameAt);
    return {
      status,
      ready: status === "ok",
      device: this.device,
      phase: this.phase,
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      checkedAt: new Date(now).toISOString(),
      uptimeMs: this.startedAt === null ? null : Math.max(0, now - this.startedAt),
      screen: this.width > 0 && this.height > 0
        ? { width: this.width, height: this.height, orientation }
        : null,
      clients: {
        ...clients,
        total: clients.mjpeg + clients.avcc + clients.hid,
      },
      frames: {
        mjpeg: this.mjpegFrames,
        avcc: this.avccFrames,
        lastAt: this.lastFrameAt === null ? null : new Date(this.lastFrameAt).toISOString(),
        lastCodec: this.lastCodec,
        staleForMs,
      },
      error: this.error
        ? { message: this.error.message, at: new Date(this.error.at).toISOString() }
        : null,
    };
  }

  private currentStatus(now: number): SessionHealthStatus {
    if (this.phase === "failed") return "failed";
    if (this.phase === "stopped") return "stopped";
    if (this.phase === "unstarted") return "starting";

    if (this.lastFrameAt === null) {
      const startingForMs = this.startedAt === null ? 0 : now - this.startedAt;
      return startingForMs > this.startupTimeoutMs ? "stalled" : "starting";
    }
    if (this.phase === "starting") return "starting";
    return now - this.lastFrameAt >= this.staleAfterMs ? "stalled" : "ok";
  }
}
