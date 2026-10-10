/**
 * Fetch loop for the raw MJPEG / Duo 3D streams. Pure (fetch and sleep are
 * injected) so the error and backoff policy is unit-tested without a DOM.
 *
 * Every failure is surfaced with a reason instead of silently retrying:
 * a non-2xx response carries the server's JSON `{error, reason, stage, details}`
 * (the 3D stream's 503), a rejected fetch is the old ERR_EMPTY_RESPONSE, and a
 * body that ends is an interrupted stream.
 */
export type StreamError = {
  /** HTTP status, or 0 when there was no response. */
  status: number;
  error: string;
  reason: string;
  stage?: string;
  details?: Record<string, unknown>;
  /** Delay before the next attempt. */
  retryInMs?: number;
};

const STREAM_RETRY_BASE_MS = 500;
const STREAM_RETRY_MAX_MS = 10_000;

/** 500 ms, 1 s, 2 s, 4 s, 8 s, then 10 s. `attempt` counts consecutive failures from 1. */
export function streamRetryDelay(attempt: number, base = STREAM_RETRY_BASE_MS, max = STREAM_RETRY_MAX_MS): number {
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
}

export async function readStreamError(res: Response): Promise<StreamError> {
  let text = "";
  try { text = await res.text(); } catch { /* body unreadable */ }
  try {
    const body = JSON.parse(text) as { error?: unknown; reason?: unknown; message?: unknown; stage?: unknown; details?: unknown };
    return {
      status: res.status,
      error: typeof body.error === "string" ? body.error : `http_${res.status}`,
      reason: typeof body.reason === "string" ? body.reason : typeof body.message === "string" ? body.message : `HTTP ${res.status}`,
      ...(typeof body.stage === "string" ? { stage: body.stage } : {}),
      ...(body.details && typeof body.details === "object" ? { details: body.details as Record<string, unknown> } : {}),
    };
  } catch {
    return { status: res.status, error: `http_${res.status}`, reason: text.trim().slice(0, 200) || `HTTP ${res.status}` };
  }
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

export async function runStreamWithRetry(options: {
  url: string;
  signal: AbortSignal;
  /** Called per connection; returns the chunk sink (a fresh frame parser). */
  connect: () => (chunk: Uint8Array) => void;
  /** First bytes of a connection: the stream is healthy again. */
  onOpen?: () => void;
  onError: (error: StreamError) => void;
  onClose?: () => void;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  let failures = 0;
  while (!options.signal.aborted) {
    let error: StreamError;
    let opened = false;
    try {
      const res = await doFetch(options.url, { signal: options.signal });
      if (!res.ok) {
        error = await readStreamError(res);
      } else if (!res.body) {
        error = { status: res.status, error: "no_body", reason: "Stream response had no body" };
      } else {
        const push = options.connect();
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.length) continue;
          if (!opened) {
            opened = true;
            failures = 0;
            options.onOpen?.();
          }
          push(value);
        }
        error = { status: res.status, error: "stream_ended", reason: "The server closed the stream" };
      }
    } catch (cause) {
      if (options.signal.aborted) break;
      error = opened
        ? { status: 0, error: "stream_interrupted", reason: "The stream was interrupted" }
        : { status: 0, error: "no_response", reason: `No response from the server (${cause instanceof Error ? cause.message : String(cause)})` };
    }
    if (opened) options.onClose?.();
    if (options.signal.aborted) break;
    failures++;
    const retryInMs = streamRetryDelay(failures);
    options.onError({ ...error, retryInMs });
    await sleep(retryInMs, options.signal);
  }
}
