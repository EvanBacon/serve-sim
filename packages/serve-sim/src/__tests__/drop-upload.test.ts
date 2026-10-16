import { describe, expect, test } from "bun:test";
import {
  DROP_CHUNK_BYTES,
  INSTALL_REQUIRES_EXEC_MESSAGE,
  arrayBufferToBase64,
  fileExtension,
  uploadDroppedFile,
  uploadFileToTmp,
} from "../client/utils/drop";
import type { HostActionResult } from "../client/utils/exec";

const OK: HostActionResult = { stdout: "", stderr: "", exitCode: 0 };

interface Call { method: string; params: Record<string, unknown> }

function recordingHost(calls: Call[]) {
  return async (method: string, params: Record<string, unknown> = {}): Promise<HostActionResult> => {
    calls.push({ method, params });
    return OK;
  };
}

// Decode one uploadChunk action's base64 payload.
function decodeChunk(call: Call): { bytes: Uint8Array; append: boolean } {
  if (call.method !== "uploadChunk") throw new Error(`not a chunk write: ${call.method}`);
  const bin = atob(String(call.params.data));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, append: call.params.append === true };
}

function patternBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
  return bytes;
}

describe("arrayBufferToBase64", () => {
  test("matches btoa for small input", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(arrayBufferToBase64(bytes.buffer)).toBe(btoa(String.fromCharCode(...bytes)));
  });

  test("round-trips across the 32KB block boundary", () => {
    const bytes = patternBytes(0x8000 * 2 + 13);
    const decoded = atob(arrayBufferToBase64(bytes.buffer));
    expect(decoded.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      if (decoded.charCodeAt(i) !== bytes[i]) {
        throw new Error(`byte ${i} mismatch`);
      }
    }
  });
});

describe("fileExtension", () => {
  // Mirrors host-rpc.ts UPLOAD_PATH_RE's extension group.
  const SERVER_EXT = /^[a-z0-9]{1,10}$/;
  const ext = (name: string, type = "") => fileExtension(new File([], name, { type }));

  test("keeps ordinary extensions, lowercased", () => {
    expect(ext("Photo.JPG")).toBe("jpg");
    expect(ext("clip.mp4")).toBe("mp4");
  });

  test("strips characters the server rejects and caps the length", () => {
    expect(ext("weird.jp-g")).toBe("jpg");
    expect(ext("x.tar_gz")).toBe("targz");
    expect(ext("x.ÉXT")).toBe("xt");
    expect(ext("x.abcdefghijklmnop")).toBe("abcdefghij");
  });

  test("falls back to bin when nothing usable is left", () => {
    expect(ext("trailing.")).toBe("bin");
    expect(ext("x.---")).toBe("bin");
    expect(ext("x.日本")).toBe("bin");
  });

  test("names without a dot still use the MIME fallback", () => {
    expect(ext("noext", "video/mp4")).toBe("mp4");
    expect(ext("noext", "image/png")).toBe("jpg");
  });

  test("every result satisfies the server's upload path format", () => {
    for (const name of ["a.JPG", "a.", "a.-_-", "a.x y", "a.ab.cd", "a.0123456789abc", "a.é", "a"]) {
      expect(ext(name)).toMatch(SERVER_EXT);
    }
  });
});

describe("uploadDroppedFile", () => {
  test("chunked writes reconstruct the original file, then addmedia + cleanup", async () => {
    // 2.5 chunks so the loop exercises both the > create and >> append paths.
    const original = patternBytes(Math.floor(DROP_CHUNK_BYTES * 2.5));
    const file = new File([original], "shot.png", { type: "image/png" });
    const calls: Call[] = [];
    const progress: Array<number | null> = [];

    await uploadDroppedFile(file, "media", recordingHost(calls), "UDID", (p) =>
      progress.push(p),
    );

    const chunkCalls = calls.filter((c) => c.method === "uploadChunk");
    expect(chunkCalls.length).toBe(3);
    expect(decodeChunk(chunkCalls[0]!).append).toBe(false);
    expect(decodeChunk(chunkCalls[1]!).append).toBe(true);
    const tmpPath = chunkCalls[0]!.params.path;
    expect(chunkCalls.every((c) => c.params.path === tmpPath)).toBe(true);

    const reassembled = new Uint8Array(original.length);
    let offset = 0;
    for (const call of chunkCalls) {
      const { bytes } = decodeChunk(call);
      // Each slice is encoded and shipped independently, so no chunk should
      // ever exceed the slice size (the whole file is never materialized).
      expect(bytes.length).toBeLessThanOrEqual(DROP_CHUNK_BYTES);
      reassembled.set(bytes, offset);
      offset += bytes.length;
    }
    expect(offset).toBe(original.length);
    expect(reassembled).toEqual(original);

    expect(calls).toContainEqual({ method: "addMedia", params: { udid: "UDID", path: tmpPath } });
    expect(calls).toContainEqual({ method: "uploadRemove", params: { path: tmpPath } });

    // Progress climbs monotonically, then flips to indeterminate for addmedia.
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBeNull();
    const fractions = progress.filter((p): p is number => p !== null);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]!).toBeGreaterThan(fractions[i - 1]!);
    }
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  test("ipa drops install instead of addmedia", async () => {
    const file = new File([patternBytes(64)], "app.ipa", { type: "" });
    const calls: Call[] = [];
    await uploadDroppedFile(file, "ipa", recordingHost(calls), "UDID", () => {});
    const install = calls.find((c) => c.method === "installApp");
    expect(install?.params.udid).toBe("UDID");
    expect(String(install?.params.path)).toMatch(/^\/tmp\/serve-sim-install-.*\.ipa$/);
    expect(calls.some((c) => c.method === "addMedia")).toBe(false);
  });

  test("ipa drops are refused up front when the server lacks --allow-exec", async () => {
    const file = new File([patternBytes(64)], "app.ipa", { type: "" });
    const calls: Call[] = [];
    await expect(
      uploadDroppedFile(file, "ipa", recordingHost(calls), "UDID", () => {}, { allowInstall: false }),
    ).rejects.toThrow(INSTALL_REQUIRES_EXEC_MESSAGE);
    expect(calls).toEqual([]);
  });

  test("a server-side installApp refusal surfaces as the upload error", async () => {
    const host = async (method: string): Promise<HostActionResult> =>
      method === "uploadChunk"
        ? { stdout: "", stderr: "installApp requires --allow-exec", exitCode: 126 }
        : OK;
    const file = new File([patternBytes(64)], "app.ipa", { type: "" });
    await expect(uploadDroppedFile(file, "ipa", host, "UDID", () => {})).rejects.toThrow(
      "installApp requires --allow-exec",
    );
  });

  test("failed chunk write surfaces stderr and still cleans up", async () => {
    const calls: Call[] = [];
    const host = async (method: string, params: Record<string, unknown> = {}): Promise<HostActionResult> => {
      calls.push({ method, params });
      if (method === "uploadChunk") {
        return { stdout: "", stderr: "disk full", exitCode: 1 };
      }
      return OK;
    };
    const file = new File([patternBytes(64)], "shot.png", { type: "image/png" });
    await expect(
      uploadDroppedFile(file, "media", host, "UDID", () => {}),
    ).rejects.toThrow("disk full");
    expect(calls.some((c) => c.method === "uploadRemove")).toBe(true);
  });
});

describe("uploadFileToTmp", () => {
  test("stages the file under /tmp with the given prefix and extension", async () => {
    const original = patternBytes(DROP_CHUNK_BYTES + 100);
    const file = new File([original], "src.jpg", { type: "image/jpeg" });
    const calls: Call[] = [];
    const tmpPath = await uploadFileToTmp(file, "serve-sim-camsrc", "jpg", recordingHost(calls));
    expect(tmpPath).toMatch(/^\/tmp\/serve-sim-camsrc-.*\.jpg$/);

    const chunkCalls = calls.filter((c) => c.method === "uploadChunk");
    expect(chunkCalls.length).toBe(2);
    const total = chunkCalls.reduce(
      (sum, c) => sum + decodeChunk(c).bytes.length,
      0,
    );
    expect(total).toBe(original.length);
  });
});
