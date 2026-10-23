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
  onOpen?.();
  try {
    await pipeline(readChunks(body), file);
  } catch (error) {
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  return file.bytesWritten;
}

// Read via the web reader rather than `Readable.fromWeb`: some Bun releases
// (1.3.x) never surface a mid-stream body error through `fromWeb`, so the
// pipeline hangs. If the write side fails first, cancel the body so the
// underlying connection is released.
async function* readChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let done = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) { done = true; return; }
      yield result.value;
    }
  } catch (error) {
    done = true; // The body already errored; nothing to cancel.
    throw error;
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
