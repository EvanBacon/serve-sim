import { once } from "events";
import { createWriteStream } from "fs";
import { rm } from "fs/promises";
import { pipeline } from "stream/promises";

/**
 * Stream a `/recording/stop` response body to `path` without buffering it:
 * a 30 min recording can be several GB, past what fits in memory (or in one
 * Node Buffer). `exclusive` refuses to replace an existing file. A partial
 * file is removed if the body or the write fails. `onOpen` fires once
 * `path` is ours (created or truncated). Resolves to bytes written.
 */
export async function saveRecordingBody(
  body: ReadableStream<Uint8Array>,
  path: string,
  { exclusive, onOpen }: { exclusive: boolean; onOpen?: () => void },
): Promise<number> {
  const file = createWriteStream(path, { flags: exclusive ? "wx" : "w" });
  try {
    await once(file, "open");
  } catch (error) {
    // Never delete a file we didn't create (wx collision); release the body.
    await body.cancel().catch(() => {});
    throw error;
  }
  try {
    onOpen?.();
    await pipeline(({ signal } = {}) => readChunks(body, signal), file);
  } catch (error) {
    // pipeline already destroyed the file; this covers an `onOpen` throw.
    if (!file.closed) {
      const closed = once(file, "close");
      file.destroy();
      await closed.catch(() => {});
    }
    await body.cancel().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  return file.bytesWritten;
}

// Read via the web reader rather than `Readable.fromWeb`: some Bun releases
// (1.3.x) never surface a mid-stream body error through `fromWeb`, so the
// pipeline hangs. If the write side fails first, pipeline aborts `signal`:
// cancel the body right away (even mid-read) so a stalled body can't hang the
// pipeline, and the underlying connection is released.
export async function* readChunks(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let settled = false; // The body ended, errored, or was already cancelled.
  const cancel = () => {
    if (settled) return;
    settled = true;
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) cancel();
    while (true) {
      const result = await reader.read();
      signal?.throwIfAborted();
      if (result.done) { settled = true; return; }
      yield result.value;
    }
  } catch (error) {
    settled = true;
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
