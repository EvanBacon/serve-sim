/**
 * Diagnostics for #103 ("live, then Connecting forever"). When the relay
 * staleness check flips the pill to connecting, one `console.warn` per stale
 * episode records what the stream reader saw, so a user's hang tells apart:
 * no bytes arriving (connection silent / server stuck on drain), bytes
 * arriving but the parser not producing frames, or frames arriving while the
 * pill stays on connecting. Pure bookkeeping: no timers, no reconnects.
 */
export type StreamPath = "mjpeg-js" | "h264";

/** Mutable counters the stream reader updates in place (cheap per chunk). */
export type StreamReadStats = {
  /** Epoch ms of the last non-empty chunk; 0 until the first. */
  lastChunkAt: number;
  /** Bytes received across all connections. */
  bytes: number;
  /** Frames the parser emitted across all connections. */
  frames: number;
  /** Epoch ms of the last parsed frame; 0 until the first. */
  lastFrameAt: number;
  /** Bytes the parser is holding without a complete frame yet. */
  bufferedBytes: number;
  /** True while a `reader.read()` is awaiting the next chunk. */
  readPending: boolean;
  /** Stream connections opened (1 + reconnects). */
  connections: number;
};

export function createStreamReadStats(): StreamReadStats {
  return { lastChunkAt: 0, bytes: 0, frames: 0, lastFrameAt: 0, bufferedBytes: 0, readPending: false, connections: 0 };
}

/** Records one non-empty chunk. */
export function noteStreamChunk(stats: StreamReadStats | undefined, length: number, now = Date.now()): void {
  if (!stats) return;
  stats.bytes += length;
  stats.lastChunkAt = now;
}

/** Records one parsed frame. */
export function noteStreamFrame(stats: StreamReadStats | undefined, now = Date.now()): void {
  if (!stats) return;
  stats.frames++;
  stats.lastFrameAt = now;
}

const ago = (now: number, at: number): number | null => (at ? now - at : null);

export function streamStaleReport(input: {
  path: StreamPath;
  stats?: StreamReadStats | null;
  /** Epoch ms of the last frame the view painted/accepted. */
  lastViewFrameAt: number;
  hidden: boolean;
  now?: number;
}): Record<string, unknown> {
  const now = input.now ?? Date.now();
  const s = input.stats;
  return {
    path: input.path,
    msSinceLastChunk: s ? ago(now, s.lastChunkAt) : null,
    msSinceLastFrame: ago(now, s?.lastFrameAt || input.lastViewFrameAt),
    msSinceLastViewFrame: ago(now, input.lastViewFrameAt),
    bytes: s?.bytes ?? null,
    frames: s?.frames ?? null,
    bufferedBytes: s?.bufferedBytes ?? null,
    readPending: s?.readPending ?? null,
    connections: s?.connections ?? null,
    hidden: input.hidden,
  };
}

/**
 * Fires `warn` once per stale episode: `stale()` warns on the first call and
 * is a no-op until `frame()` ends the episode.
 */
export function createStaleEpisode(warn: (message: string, details: Record<string, unknown>) => void = console.warn) {
  let reported = false;
  return {
    stale(details: () => Record<string, unknown>): boolean {
      if (reported) return false;
      reported = true;
      warn("[serve-sim] stream stale", details());
      return true;
    },
    frame(): void {
      reported = false;
    },
  };
}
