import { createWriteStream } from "fs";
import { rm } from "fs/promises";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";

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
  let opened = false;
  file.once("open", () => { opened = true; onOpen?.(); });
  try {
    await pipeline(Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>), file);
  } catch (error) {
    // Never delete a file we didn't create (wx collision).
    if (opened) await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  return file.bytesWritten;
}
