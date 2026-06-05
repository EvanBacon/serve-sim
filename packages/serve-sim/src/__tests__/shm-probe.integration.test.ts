import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "child_process";
import { existsSync, statSync } from "fs";
import { join } from "path";
import net from "net";

const HELPER_PATH = join(
  import.meta.dir,
  "../../dist/simcam/serve-sim-camera-helper",
);

const SIMCAM_MAGIC = 0x53434d31;
const SIMCAM_PIXEL_BGRA = 0;
const HEADER_BYTES = 64;
const SURFACE_RING = 4;
// SimCamSurfaceTable: surfaceCount + latestIndex + ids[SURFACE_RING].
const TABLE_BYTES = 4 + 4 + SURFACE_RING * 4;
const CONTROL_BYTES = HEADER_BYTES + TABLE_BYTES;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

function helperReady(): boolean {
  try {
    return statSync(HELPER_PATH).isFile();
  } catch {
    return false;
  }
}

const platformOk = process.platform === "darwin";
const shouldRun = platformOk && helperReady();

interface ShmHandle {
  ptr: number;
  buffer: ArrayBuffer;
  fd: number;
  size: number;
}

let lib:
  | undefined
  | {
      shm_open: (name: Buffer, oflag: number, mode: number) => number;
      mmap: (
        addr: number | null,
        len: bigint,
        prot: number,
        flags: number,
        fd: number,
        offset: bigint,
      ) => unknown;
      munmap: (addr: unknown, len: bigint) => number;
      close: (fd: number) => number;
      shm_unlink: (name: Buffer) => number;
      toArrayBuffer: (ptr: unknown, byteOffset: number, byteLength: number) => ArrayBuffer;
    };

async function loadFfi(): Promise<NonNullable<typeof lib>> {
  if (lib) return lib;
  const { dlopen, FFIType, read } = await import("bun:ffi");
  void read;
  const handle = dlopen("libSystem.dylib", {
    shm_open: { args: [FFIType.cstring, FFIType.i32, FFIType.u16], returns: FFIType.i32 },
    mmap: {
      args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i64],
      returns: FFIType.ptr,
    },
    munmap: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    shm_unlink: { args: [FFIType.cstring], returns: FFIType.i32 },
  });
  const { toArrayBuffer } = await import("bun:ffi");
  lib = {
    shm_open: (name, oflag, mode) =>
      Number(handle.symbols.shm_open(name as never, oflag, mode) as number),
    mmap: (addr, len, prot, flags, fd, offset) =>
      handle.symbols.mmap(
        addr as never,
        len as never,
        prot,
        flags,
        fd,
        offset as never,
      ) as unknown,
    munmap: (addr, len) => Number(handle.symbols.munmap(addr as never, len as never) as number),
    close: (fd) => Number(handle.symbols.close(fd) as number),
    shm_unlink: (name) => Number(handle.symbols.shm_unlink(name as never) as number),
    toArrayBuffer: (ptr, off, len) => toArrayBuffer(ptr as never, off, len),
  };
  return lib;
}

async function openExistingShm(name: string): Promise<ShmHandle | null> {
  const sys = await loadFfi();
  const fd = sys.shm_open(Buffer.from(`${name}\0`), 0, 0);
  if (fd < 0) return null;
  const size = CONTROL_BYTES;
  const ptr = sys.mmap(null, BigInt(size), 1, 1, fd, 0n);
  if (!ptr) {
    sys.close(fd);
    return null;
  }
  const buffer = sys.toArrayBuffer(ptr, 0, size);
  return { ptr: 0, buffer, fd, size };
}

async function closeShm(handle: ShmHandle): Promise<void> {
  const sys = await loadFfi();
  sys.close(handle.fd);
}

function readHeader(buffer: ArrayBuffer): {
  magic: number;
  version: number;
  width: number;
  height: number;
  pixelFormat: number;
  bytesPerRow: number;
  pixelByteSize: bigint;
  frameSeq: bigint;
  timestampNs: bigint;
  mirrorMode: number;
} {
  const view = new DataView(buffer);
  return {
    magic: view.getUint32(0, true),
    version: view.getUint32(4, true),
    width: view.getUint32(8, true),
    height: view.getUint32(12, true),
    pixelFormat: view.getUint32(16, true),
    bytesPerRow: view.getUint32(20, true),
    pixelByteSize: view.getBigUint64(24, true),
    frameSeq: view.getBigUint64(32, true),
    timestampNs: view.getBigUint64(40, true),
    mirrorMode: view.getUint8(48),
  };
}

function readSurfaceTable(buffer: ArrayBuffer): {
  surfaceCount: number;
  latestIndex: number;
  ids: number[];
} {
  const view = new DataView(buffer);
  const surfaceCount = view.getUint32(HEADER_BYTES, true);
  const latestIndex = view.getUint32(HEADER_BYTES + 4, true);
  const ids: number[] = [];
  for (let i = 0; i < SURFACE_RING; i++) {
    ids.push(view.getUint32(HEADER_BYTES + 8 + i * 4, true));
  }
  return { surfaceCount, latestIndex, ids };
}

let iosurface:
  | undefined
  | {
      lookup: (id: number) => unknown;
      width: (surface: unknown) => number;
      height: (surface: unknown) => number;
      release: (surface: unknown) => void;
    };

async function loadIOSurface(): Promise<NonNullable<typeof iosurface>> {
  if (iosurface) return iosurface;
  const { dlopen, FFIType } = await import("bun:ffi");
  const io = dlopen("/System/Library/Frameworks/IOSurface.framework/IOSurface", {
    IOSurfaceLookup: { args: [FFIType.u32], returns: FFIType.ptr },
    IOSurfaceGetWidth: { args: [FFIType.ptr], returns: FFIType.u64 },
    IOSurfaceGetHeight: { args: [FFIType.ptr], returns: FFIType.u64 },
  });
  const cf = dlopen(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    { CFRelease: { args: [FFIType.ptr], returns: FFIType.void } },
  );
  iosurface = {
    lookup: (id) => io.symbols.IOSurfaceLookup(id) as unknown,
    width: (s) => Number(io.symbols.IOSurfaceGetWidth(s as never) as bigint),
    height: (s) => Number(io.symbols.IOSurfaceGetHeight(s as never) as bigint),
    release: (s) => {
      cf.symbols.CFRelease(s as never);
    },
  };
  return iosurface;
}

function sendHelperCommand(socketPath: string, cmd: object, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    c.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0 && !settled) {
        settled = true;
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (err) {
          reject(err);
        }
        c.end();
      }
    });
    c.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    c.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("socket closed before reply"));
      }
    });
    c.write(JSON.stringify(cmd) + "\n");
    setTimeout(() => {
      if (!settled) {
        settled = true;
        c.destroy();
        reject(new Error("helper command timed out"));
      }
    }, timeoutMs).unref();
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const describeIf = shouldRun ? describe : describe.skip;

describeIf("SimCameraHelper shm probe", () => {
  const TAG = `${process.pid.toString(36)}${Date.now().toString(36)}`.slice(-10);
  const SHM_NAME = `/sscam-tst-${TAG}`;
  const SOCKET_PATH = `/tmp/sscam-tst-${TAG}.sock`;
  let helper: ChildProcessByStdio<null, null, null> | null = null;
  let helperStderr = "";

  beforeAll(async () => {
    helper = spawn(
      HELPER_PATH,
      ["--shm", SHM_NAME, "--socket", SOCKET_PATH, "--source", "placeholder"],
      { stdio: ["ignore", "ignore", "pipe"] },
    ) as unknown as ChildProcessByStdio<null, null, null>;
    const stderr = (helper as unknown as { stderr: NodeJS.ReadableStream | null }).stderr;
    stderr?.on("data", (chunk: Buffer) => { helperStderr += chunk.toString(); });

    const ok = await waitFor(() => existsSync(SOCKET_PATH), 5000);
    if (!ok) {
      throw new Error(
        `helper never bound socket ${SOCKET_PATH}\n` +
          `helper stderr (first 600 chars):\n${helperStderr.slice(0, 600)}`,
      );
    }
  }, 10_000);

  afterAll(async () => {
    if (helper && !helper.killed) {
      try { helper.kill("SIGTERM"); } catch {}
    }
    try {
      const sys = await loadFfi();
      sys.shm_unlink(Buffer.from(`${SHM_NAME}\0`));
    } catch {}
  });

  test("publishes a shm region with the documented header layout", async () => {
    const handle = await openExistingShm(SHM_NAME);
    expect(handle).not.toBeNull();
    if (!handle) return;
    try {
      const header = readHeader(handle.buffer);
      expect(header.magic).toBe(SIMCAM_MAGIC);
      expect(header.version).toBeGreaterThanOrEqual(1);
      expect(header.width).toBe(DEFAULT_WIDTH);
      expect(header.height).toBe(DEFAULT_HEIGHT);
      expect(header.pixelFormat).toBe(SIMCAM_PIXEL_BGRA);
      expect(header.bytesPerRow).toBeGreaterThanOrEqual(DEFAULT_WIDTH * 4);
      expect(header.pixelByteSize).toBe(BigInt(DEFAULT_WIDTH * DEFAULT_HEIGHT * 4));
    } finally {
      await closeShm(handle);
    }
  });

  test("frame sequence number advances while running", async () => {
    const handle = await openExistingShm(SHM_NAME);
    expect(handle).not.toBeNull();
    if (!handle) return;
    try {
      const start = readHeader(handle.buffer).frameSeq;
      const advanced = await waitFor(
        () => readHeader(handle.buffer).frameSeq > start,
        2000,
      );
      expect(advanced).toBe(true);
    } finally {
      await closeShm(handle);
    }
  });

  test("publishes an IOSurface ring resolvable by global id", async () => {
    const handle = await openExistingShm(SHM_NAME);
    expect(handle).not.toBeNull();
    if (!handle) return;
    try {
      const table = readSurfaceTable(handle.buffer);
      expect(table.surfaceCount).toBe(SURFACE_RING);
      expect(table.latestIndex).toBeLessThan(table.surfaceCount);
      const latestSurfaceId = table.ids[table.latestIndex];
      if (latestSurfaceId === undefined) {
        throw new Error(`missing IOSurface ID at index ${table.latestIndex}`);
      }
      // All ring slots carry a distinct, non-zero global surface id.
      const unique = new Set(table.ids);
      expect(unique.size).toBe(SURFACE_RING);
      expect(table.ids.every((id) => id > 0)).toBe(true);

      // The latest surface resolves cross-process and matches the header dims.
      const io = await loadIOSurface();
      const surface = io.lookup(latestSurfaceId);
      expect(surface).toBeTruthy();
      if (surface) {
        expect(io.width(surface)).toBe(DEFAULT_WIDTH);
        expect(io.height(surface)).toBe(DEFAULT_HEIGHT);
        io.release(surface);
      }
    } finally {
      await closeShm(handle);
    }
  });

  test("latestIndex stays in range as frames advance", async () => {
    const handle = await openExistingShm(SHM_NAME);
    expect(handle).not.toBeNull();
    if (!handle) return;
    try {
      const initialFrameSeq = readHeader(handle.buffer).frameSeq;
      const moved = await waitFor(() => {
        const header = readHeader(handle.buffer);
        const t = readSurfaceTable(handle.buffer);
        return header.frameSeq !== initialFrameSeq && t.latestIndex < t.surfaceCount;
      }, 1000);
      expect(moved).toBe(true);
    } finally {
      await closeShm(handle);
    }
  });

  test("control socket replies to status + switch + setMirror commands", async () => {
    const status = await sendHelperCommand(SOCKET_PATH, { action: "status" });
    expect(status.ok).toBe(true);
    expect(typeof status.source).toBe("string");

    const swapped = await sendHelperCommand(SOCKET_PATH, {
      action: "switch",
      source: "placeholder",
    });
    expect(swapped.ok).toBe(true);
    expect(swapped.source).toBe("placeholder");

    const mirror = await sendHelperCommand(SOCKET_PATH, {
      action: "setMirror",
      mode: "off",
    });
    expect(mirror.ok).toBe(true);
    expect(mirror.mirror).toBe("off");
  });

  test("dimensions and aspect ratio survive a SwitchSource call", async () => {
    await sendHelperCommand(SOCKET_PATH, { action: "switch", source: "placeholder" });
    const handle = await openExistingShm(SHM_NAME);
    expect(handle).not.toBeNull();
    if (!handle) return;
    try {
      const header = readHeader(handle.buffer);
      expect(header.width).toBe(DEFAULT_WIDTH);
      expect(header.height).toBe(DEFAULT_HEIGHT);
      expect(header.bytesPerRow).toBeGreaterThanOrEqual(header.width * 4);
    } finally {
      await closeShm(handle);
    }
  });

  test("shutdown unmaps shm so a fresh shm_open returns -1 (ENOENT)", async () => {
    if (!helper) return;
    const exited = new Promise<number | null>((resolve) => {
      helper!.once("exit", (code) => resolve(code ?? null));
    });
    try {
      await sendHelperCommand(SOCKET_PATH, { action: "shutdown" });
    } catch {}
    const exitCode = await Promise.race([
      exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    expect(exitCode).not.toBe("timeout");
    helper = null;

    const sys = await loadFfi();
    const fd = sys.shm_open(Buffer.from(`${SHM_NAME}\0`), 0, 0);
    if (fd >= 0) {
      sys.close(fd);
      sys.shm_unlink(Buffer.from(`${SHM_NAME}\0`));
    }
    expect(fd).toBeLessThan(0);
  });
});
