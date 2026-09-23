import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "http";
import { join } from "node:path";
import { DuoPreview } from "../duo-preview";
import type { DuoProjection } from "../duo-renderer";

class FakeResponse {
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  readonly chunks: Buffer[] = [];

  write(chunk: Uint8Array | string): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
}

type RenderCall = {
  jpeg: Uint8Array;
  panel: "cover" | "inner";
  angle: number;
  roll: number;
  fullResolution: boolean;
};

function harness() {
  const calls: RenderCall[] = [];
  const preview = new DuoPreview({
    createRenderer: () => ({
      close() {},
      render: async (jpeg, panel, angle, roll, fullResolution = false) => {
        calls.push({ jpeg: Uint8Array.from(jpeg), panel, angle, roll, fullResolution });
        const projection: DuoProjection = { width: 1000, height: 900, panel, hingeDegrees: angle, pieces: [] };
        return { jpeg: Buffer.from([9, calls.length]), projection };
      },
    }),
    onProjection() {},
    onStreamError() {},
  });
  return { preview, calls };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Duo live preview stream", () => {
  test("does not sharpen to a second target after idle", async () => {
    const { preview, calls } = harness();
    const response = new FakeResponse();
    preview.noteHinge(180);
    preview.attach(response as unknown as ServerResponse);
    preview.onCapturedFrame(new Uint8Array([1, 2, 3]));
    await waitFor(() => calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fullResolution).toBe(false);
    expect(response.chunks.some((chunk) => chunk.includes(Buffer.from("image/png")))).toBe(true);
    preview.close();
  });

  test("reuses the last PNG when jpeg bytes and pose are unchanged", async () => {
    const { preview, calls } = harness();
    const response = new FakeResponse();
    preview.noteHinge(180);
    preview.attach(response as unknown as ServerResponse);
    preview.onCapturedFrame(new Uint8Array([1, 2, 3]));
    await waitFor(() => calls.length === 1);
    const writes = response.chunks.length;

    preview.onCapturedFrame(new Uint8Array([1, 2, 3]));
    preview.requestFrame();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(1);
    expect(response.chunks.length).toBe(writes);

    const late = new FakeResponse();
    preview.attach(late as unknown as ServerResponse);
    expect(late.chunks.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);

    preview.onCapturedFrame(new Uint8Array([1, 2, 4]));
    await waitFor(() => calls.length === 2);
    expect(calls[1]!.fullResolution).toBe(false);
    expect(Array.from(calls[1]!.jpeg)).toEqual([1, 2, 4]);

    preview.noteHinge(130);
    preview.requestFrame();
    await waitFor(() => calls.length === 3);
    expect(calls[2]!.angle).toBe(130);
    expect(calls.every((call) => call.fullResolution === false)).toBe(true);
    preview.close();
  });

  test("sees a capture buffer that is mutated in place", async () => {
    const { preview, calls } = harness();
    preview.noteHinge(180);
    preview.attach(new FakeResponse() as unknown as ServerResponse);
    const buffer = new Uint8Array(8);
    buffer.set([1, 2, 3]);
    preview.onCapturedFrame(buffer.subarray(0, 3));
    await waitFor(() => calls.length === 1);
    buffer.set([4, 5, 6]);
    preview.onCapturedFrame(buffer.subarray(0, 3));
    await waitFor(() => calls.length === 2);
    expect(Array.from(calls[0]!.jpeg)).toEqual([1, 2, 3]);
    expect(Array.from(calls[1]!.jpeg)).toEqual([4, 5, 6]);
    preview.close();
  });

  test("native preview target is 1000×900 with MSAA off and no 3000 sharpen", () => {
    const source = readFileSync(join(import.meta.dir, "../../Sources/SimDuoRenderer/DuoRenderer.swift"), "utf8");
    expect(source).toContain("static let previewWidth = 1000");
    expect(source).toContain("static let previewHeight = 900");
    expect(source).toContain("width: Self.previewWidth, height: Self.previewHeight");
    expect(source).toContain("antialiasing = .none");
    expect(source).not.toContain("multisample4X");
    expect(source).not.toContain("fullResolution ? 1 : 0");
    expect(source).not.toMatch(/\[\s*1500\s*,\s*3000\s*\]/);
    expect(source).toContain("targetIndex = 0");
    const worker = readFileSync(join(import.meta.dir, "../../Sources/SimDuoRenderer/main.swift"), "utf8");
    expect(worker).toContain("fullResolution: request.fullResolution ?? false");
    expect(worker).not.toContain("fullResolution ?? true");
  });
});
