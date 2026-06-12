import { describe, expect, test } from "bun:test";
import {
  DROP_CHUNK_BYTES,
  arrayBufferToBase64,
  uploadDroppedFile,
  uploadFileToTmp,
} from "../client/utils/drop";
import type { ExecResult } from "../client/utils/exec";

const OK: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

function recordingExec(commands: string[]) {
  return async (command: string): Promise<ExecResult> => {
    commands.push(command);
    return OK;
  };
}

// Pull the base64 payload back out of a chunk-write command and decode it.
function decodeChunkCommand(command: string): { bytes: Uint8Array; op: string } {
  const match = command.match(/^bash -c 'echo ([A-Za-z0-9+/=]+) \| base64 -d (>>?) /);
  if (!match) throw new Error(`not a chunk write: ${command}`);
  const bin = atob(match[1]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, op: match[2]! };
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

describe("uploadDroppedFile", () => {
  test("chunked writes reconstruct the original file, then addmedia + cleanup", async () => {
    // 2.5 chunks so the loop exercises both the > create and >> append paths.
    const original = patternBytes(Math.floor(DROP_CHUNK_BYTES * 2.5));
    const file = new File([original], "shot.png", { type: "image/png" });
    const commands: string[] = [];
    const progress: Array<number | null> = [];

    await uploadDroppedFile(file, "media", recordingExec(commands), "UDID", (p) =>
      progress.push(p),
    );

    const chunkCommands = commands.filter((c) => c.includes("base64 -d"));
    expect(chunkCommands.length).toBe(3);
    expect(decodeChunkCommand(chunkCommands[0]!).op).toBe(">");
    expect(decodeChunkCommand(chunkCommands[1]!).op).toBe(">>");

    const reassembled = new Uint8Array(original.length);
    let offset = 0;
    for (const command of chunkCommands) {
      const { bytes } = decodeChunkCommand(command);
      // Each slice is encoded and shipped independently, so no chunk should
      // ever exceed the slice size (the whole file is never materialized).
      expect(bytes.length).toBeLessThanOrEqual(DROP_CHUNK_BYTES);
      reassembled.set(bytes, offset);
      offset += bytes.length;
    }
    expect(offset).toBe(original.length);
    expect(reassembled).toEqual(original);

    expect(commands.some((c) => c.startsWith("xcrun simctl addmedia UDID "))).toBe(true);
    expect(commands.some((c) => c.includes("rm -f "))).toBe(true);

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
    const commands: string[] = [];
    await uploadDroppedFile(file, "ipa", recordingExec(commands), "UDID", () => {});
    expect(commands.some((c) => c.startsWith("xcrun simctl install UDID "))).toBe(true);
    expect(commands.some((c) => c.includes("addmedia"))).toBe(false);
  });

  test("failed chunk write surfaces stderr and still cleans up", async () => {
    const commands: string[] = [];
    const exec = async (command: string): Promise<ExecResult> => {
      commands.push(command);
      if (command.includes("base64 -d")) {
        return { stdout: "", stderr: "disk full", exitCode: 1 };
      }
      return OK;
    };
    const file = new File([patternBytes(64)], "shot.png", { type: "image/png" });
    await expect(
      uploadDroppedFile(file, "media", exec, "UDID", () => {}),
    ).rejects.toThrow("disk full");
    expect(commands.some((c) => c.includes("rm -f "))).toBe(true);
  });
});

describe("uploadFileToTmp", () => {
  test("stages the file under /tmp with the given prefix and extension", async () => {
    const original = patternBytes(DROP_CHUNK_BYTES + 100);
    const file = new File([original], "src.jpg", { type: "image/jpeg" });
    const commands: string[] = [];
    const tmpPath = await uploadFileToTmp(file, "serve-sim-camsrc", "jpg", recordingExec(commands));
    expect(tmpPath).toMatch(/^\/tmp\/serve-sim-camsrc-.*\.jpg$/);

    const chunkCommands = commands.filter((c) => c.includes("base64 -d"));
    expect(chunkCommands.length).toBe(2);
    const total = chunkCommands.reduce(
      (sum, c) => sum + decodeChunkCommand(c).bytes.length,
      0,
    );
    expect(total).toBe(original.length);
  });
});
