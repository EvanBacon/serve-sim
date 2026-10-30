import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readChunks, saveRecordingBody } from "../record-file";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "record-file-"));
  dirs.push(dir);
  return dir;
}

function streamOf(chunks: Array<Uint8Array | Error>, onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    cancel() { onCancel?.(); },
    pull(controller) {
      const next = chunks[i++];
      if (next === undefined) controller.close();
      else if (next instanceof Error) controller.error(next);
      else controller.enqueue(next);
    },
  });
}

describe("saveRecordingBody", () => {
  test("streams every chunk to the file and reports the size", async () => {
    const out = join(tempDir(), "a.mp4");
    const chunks = Array.from({ length: 64 }, (_, i) => new Uint8Array(16 * 1024).fill(i));
    const bytes = await saveRecordingBody(streamOf(chunks), out, { exclusive: true });
    expect(bytes).toBe(64 * 16 * 1024);
    const saved = readFileSync(out);
    expect(saved.length).toBe(bytes);
    expect(saved[0]).toBe(0);
    expect(saved[saved.length - 1]).toBe(63);
  });

  test("an exclusive save never clobbers an existing file", async () => {
    const out = join(tempDir(), "taken.mp4");
    writeFileSync(out, "earlier");
    let cancelled = false;
    await expect(saveRecordingBody(streamOf([new Uint8Array([1])], () => { cancelled = true; }), out, { exclusive: true }))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(out, "utf8")).toBe("earlier");
    // The response body is released, not left holding the connection open.
    expect(cancelled).toBe(true);
  });

  test("--output overwrites", async () => {
    const out = join(tempDir(), "out.mp4");
    writeFileSync(out, "old contents");
    await saveRecordingBody(streamOf([new Uint8Array([7, 8])]), out, { exclusive: false });
    expect([...readFileSync(out)]).toEqual([7, 8]);
  });

  test("a body that fails midway leaves no partial file", async () => {
    const out = join(tempDir(), "broken.mp4");
    await expect(saveRecordingBody(streamOf([new Uint8Array(1024), new Error("socket hang up")]), out, { exclusive: true }))
      .rejects.toThrow("socket hang up");
    expect(existsSync(out)).toBe(false);
  });

  test("an onOpen that throws removes the new file and releases the body", async () => {
    const out = join(tempDir(), "open.mp4");
    let cancelled = false;
    await expect(saveRecordingBody(streamOf([new Uint8Array([1])], () => { cancelled = true; }), out, {
      exclusive: true,
      onOpen: () => { throw new Error("boom"); },
    })).rejects.toThrow("boom");
    expect(existsSync(out)).toBe(false);
    expect(cancelled).toBe(true);
  });
});

describe("readChunks", () => {
  test("an abort mid-read cancels the body without waiting for the read", async () => {
    let cancelled = false;
    // Never produces a chunk: the read stays pending until cancelled.
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const controller = new AbortController();
    const reading = readChunks(body, controller.signal).next();
    controller.abort(new Error("write failed"));
    await expect(reading).rejects.toThrow("write failed");
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
});
