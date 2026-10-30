export type StreamWindowResult = {
  response: Response;
  /** stopped: `onChunk` returned true. done: the server ended the body. deadline: `windowMs` elapsed. */
  ended: "stopped" | "done" | "deadline";
};

/**
 * Fetch `url` and feed body chunks to `onChunk` until it returns true, the body
 * ends, or `windowMs` (measured from the request) elapses.
 *
 * The deadline cancels the reader rather than aborting the fetch. Aborting
 * while a read() is pending errors the body, and the follow-up
 * `reader.cancel()` then rejects with an AbortError; unawaited, that rejection
 * fails the whole file under `bun test` even though every test passed. A
 * cancel resolves the pending read() as done instead, and every cancel here
 * is awaited.
 */
export async function readStreamWindow(
  url: string,
  windowMs: number,
  onChunk: (chunk: Uint8Array) => boolean | void,
): Promise<StreamWindowResult> {
  const t0 = Date.now();
  // The abort signal bounds only the wait for headers; it is disarmed before
  // the body is read.
  const controller = new AbortController();
  const headersTimer = setTimeout(() => controller.abort(), windowMs + 500);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(headersTimer);
  }

  const reader = response.body!.getReader();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, Math.max(0, windowMs - (Date.now() - t0)));
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { response, ended: timedOut ? "deadline" : "done" };
      if (onChunk(value) === true) return { response, ended: "stopped" };
    }
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => {});
  }
}
