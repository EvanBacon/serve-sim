import { createHash } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { Socket } from "net";
import { findAdb, parseWmSize } from "./android-device";

type SimulatorOrientation = "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";

interface AndroidHelperOptions {
  serial: string;
  port: number;
  maxFps?: number;
  maxLongEdge?: number;
}

interface TouchPoint {
  x: number;
  y: number;
}

interface TouchGesture {
  last: TouchPoint;
}

interface ScreenConfig {
  width: number;
  height: number;
  orientation: SimulatorOrientation;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const STREAM_BOUNDARY = "frame";
const DEFAULT_MAX_FPS = 5;
const DEFAULT_MAX_LONG_EDGE = 1200;
const DEFAULT_VIDEO_BIT_RATE = 8_000_000;
const SCREENRECORD_TIME_LIMIT_SECONDS = 180;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const TOUCH_MOVE_INTERVAL_MS = 16;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache, no-store",
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  res.end(body);
}

function adbBuffer(serial: string, args: string[], timeoutMs = 5_000): Promise<Buffer> {
  const adb = findAdb();
  if (!adb) return Promise.reject(new Error("adb not found"));
  return new Promise((resolve, reject) => {
    const child = spawn(adb, ["-s", serial, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`adb ${args.join(" ")} timed out`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_FRAME_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        const message = Buffer.concat(stderr).toString("utf-8").trim();
        reject(new Error(message || `adb ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

function adbSpawn(serial: string, args: string[]): ChildProcess {
  const adb = findAdb();
  if (!adb) throw new Error("adb not found");
  return spawn(adb, ["-s", serial, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function adbShell(serial: string): ChildProcess {
  const adb = findAdb();
  if (!adb) throw new Error("adb not found");
  return spawn(adb, ["-s", serial, "shell"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
}

async function adbText(serial: string, args: string[], timeoutMs = 5_000): Promise<string> {
  return (await adbBuffer(serial, args, timeoutMs)).toString("utf-8");
}

export function parsePngDimensions(buffer: Uint8Array): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return null;
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function mjpegChunk(frame: Buffer): Buffer {
  const header =
    `--${STREAM_BOUNDARY}\r\n` +
    "Content-Type: image/png\r\n" +
    `Content-Length: ${frame.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header), frame, Buffer.from("\r\n")]);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

class AndroidInputShell {
  private child: ChildProcess | null = null;
  private stopped = false;

  constructor(private readonly serial: string) {}

  write(command: string): void {
    if (this.stopped) return;
    const child = this.ensureChild();
    if (!child.stdin?.writable) return;
    child.stdin.write(`${command}\n`);
  }

  stop(): void {
    this.stopped = true;
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    this.child = null;
  }

  private ensureChild(): ChildProcess {
    if (this.child && !this.child.killed && this.child.stdin?.writable) {
      return this.child;
    }

    const child = adbShell(this.serial);
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf-8").trim();
      if (message) console.error("[android-input]", message);
    });
    child.on("error", (err) => {
      if (!this.stopped) console.error("[android-input]", err.message);
    });
    child.on("close", () => {
      if (this.child === child) this.child = null;
    });
    return child;
  }
}

function androidKeyCodeForButton(button: string): number | null {
  switch (button) {
    case "home":
      return 3;
    case "back":
      return 4;
    case "app_switcher":
    case "recents":
      return 187;
    case "lock":
    case "power":
      return 26;
    case "volume_up":
      return 24;
    case "volume_down":
      return 25;
    case "menu":
      return 82;
    default:
      return null;
  }
}

export function androidKeyCodeForHidUsage(usage: number): number | null {
  if (usage >= 0x04 && usage <= 0x1d) return 29 + (usage - 0x04);
  if (usage >= 0x1e && usage <= 0x26) return 8 + (usage - 0x1e);
  if (usage === 0x27) return 7;
  const map: Record<number, number> = {
    0x28: 66,
    0x29: 111,
    0x2a: 67,
    0x2b: 61,
    0x2c: 62,
    0x2d: 69,
    0x2e: 70,
    0x2f: 71,
    0x30: 72,
    0x31: 73,
    0x33: 74,
    0x34: 75,
    0x35: 68,
    0x36: 55,
    0x37: 56,
    0x38: 76,
    0x39: 115,
    0x4f: 22,
    0x50: 21,
    0x51: 20,
    0x52: 19,
  };
  return map[usage] ?? null;
}

function rotationForOrientation(orientation: SimulatorOrientation): number {
  switch (orientation) {
    case "landscape_left":
      return 1;
    case "portrait_upside_down":
      return 2;
    case "landscape_right":
      return 3;
    default:
      return 0;
  }
}

function parseForegroundPackage(dumpsysWindow: string): string | null {
  const focus = /mCurrentFocus=.*?\s+u\d+\s+([A-Za-z0-9_.]+)\//.exec(dumpsysWindow)
    ?? /mFocusedApp=.*?\s+u\d+\s+([A-Za-z0-9_.]+)\//.exec(dumpsysWindow);
  return focus?.[1] ?? null;
}

function parseWmSizeDetails(stdout: string): {
  physical: { width: number; height: number } | null;
  override: { width: number; height: number } | null;
} {
  const parse = (label: string) => {
    const match = new RegExp(`${label} size:\\s*(\\d+)x(\\d+)`, "i").exec(stdout);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? { width, height }
      : null;
  };
  return {
    physical: parse("Physical"),
    override: parse("Override"),
  };
}

function scaledSize(
  size: { width: number; height: number },
  maxLongEdge: number,
): { width: number; height: number } | null {
  const longEdge = Math.max(size.width, size.height);
  if (!(maxLongEdge > 0) || longEdge <= maxLongEdge) return null;
  const scale = maxLongEdge / longEdge;
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return {
    width: even(size.width * scale),
    height: even(size.height * scale),
  };
}

function websocketAccept(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function parseWebSocketFrames(
  buffer: Buffer<ArrayBufferLike>,
  onPayload: (payload: Buffer, opcode: number) => void,
): Buffer<ArrayBufferLike> {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      length = Number(big);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;
    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    }
    onPayload(payload, opcode);
    offset += frameLength;
  }
  return buffer.subarray(offset);
}

export async function runAndroidHelper({
  serial,
  port,
  maxFps = DEFAULT_MAX_FPS,
  maxLongEdge = DEFAULT_MAX_LONG_EDGE,
}: AndroidHelperOptions): Promise<void> {
  const clients = new Set<ServerResponse>();
  let latestFrame: Buffer | null = null;
  let captureRunning = false;
  let stopped = false;
  let touchGesture: TouchGesture | null = null;
  let pendingMove: TouchPoint | null = null;
  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  let config: ScreenConfig = { width: 0, height: 0, orientation: "portrait" };
  let inputSize: { width: number; height: number } | null = null;
  let videoSize: { width: number; height: number } | null = null;
  const inputShell = new AndroidInputShell(serial);

  const pointFor = (point: TouchPoint) => {
    const width = inputSize?.width || config.width || 1;
    const height = inputSize?.height || config.height || 1;
    return {
      x: Math.round(clamp01(point.x) * (width - 1)),
      y: Math.round(clamp01(point.y) * (height - 1)),
    };
  };

  const writeMotionEvent = (action: "DOWN" | "MOVE" | "UP", point: TouchPoint) => {
    const mapped = pointFor(point);
    inputShell.write(`input motionevent ${action} ${mapped.x} ${mapped.y}`);
  };

  const flushPendingMove = () => {
    if (moveTimer) {
      clearTimeout(moveTimer);
      moveTimer = null;
    }
    if (!pendingMove || !touchGesture) return;
    writeMotionEvent("MOVE", pendingMove);
    pendingMove = null;
  };

  const scheduleMove = (point: TouchPoint) => {
    pendingMove = point;
    if (moveTimer) return;
    moveTimer = setTimeout(() => {
      moveTimer = null;
      if (!pendingMove || !touchGesture) return;
      writeMotionEvent("MOVE", pendingMove);
      pendingMove = null;
    }, TOUCH_MOVE_INTERVAL_MS);
  };

  const refreshConfig = async () => {
    try {
      const wm = await adbText(serial, ["shell", "wm", "size"], 2500);
      const details = parseWmSizeDetails(wm);
      const size = details.override ?? details.physical ?? parseWmSize(wm);
      if (size) {
        inputSize = size;
        videoSize = scaledSize(size, maxLongEdge) ?? size;
        config = { ...config, ...videoSize };
      }
    } catch {}
  };

  const captureFrame = async (): Promise<Buffer> => {
    const frame = await adbBuffer(serial, ["exec-out", "screencap", "-p"], 8_000);
    const size = parsePngDimensions(frame);
    if (size) {
      inputSize = size;
      config = { ...config, ...size };
    }
    return frame;
  };

  const broadcastFrame = (frame: Buffer) => {
    latestFrame = frame;
    if (clients.size === 0) return;
    const chunk = mjpegChunk(frame);
    for (const res of [...clients]) {
      if (res.destroyed || res.writableEnded) {
        clients.delete(res);
        continue;
      }
      res.write(chunk);
    }
  };

  const ensureCaptureLoop = () => {
    if (captureRunning) return;
    captureRunning = true;
    void (async () => {
      console.log("[android] Capture started");
      const frameDelay = Math.max(50, Math.round(1000 / Math.max(1, maxFps)));
      while (!stopped && clients.size > 0) {
        const started = Date.now();
        try {
          broadcastFrame(await captureFrame());
        } catch (err) {
          console.error("[android-capture]", err instanceof Error ? err.message : err);
          await sleep(1000);
        }
        await sleep(Math.max(0, frameDelay - (Date.now() - started)));
      }
      captureRunning = false;
    })();
  };

  await refreshConfig();

  const handleTouch = (payload: any) => {
    const point = { x: Number(payload.x), y: Number(payload.y) };
    if (payload.type === "begin") {
      touchGesture = { last: point };
      pendingMove = null;
      writeMotionEvent("DOWN", point);
      return;
    }
    if (!touchGesture) return;
    if (payload.type === "move") {
      touchGesture.last = point;
      scheduleMove(point);
      return;
    }
    if (payload.type !== "end") return;
    flushPendingMove();
    touchGesture = null;
    writeMotionEvent("UP", point);
  };

  const handleMessage = (payload: Buffer) => {
    if (payload.length < 1) return;
    const type = payload[0]!;
    const body = payload.length > 1
      ? JSON.parse(payload.subarray(1).toString("utf-8"))
      : {};

    if (type === 0x03) {
      handleTouch(body);
    } else if (type === 0x04) {
      const keyCode = androidKeyCodeForButton(String(body.button ?? ""));
      if (keyCode != null) {
        inputShell.write(`input keyevent ${keyCode}`);
      }
    } else if (type === 0x06) {
      if (body.type !== "down") return;
      const keyCode = androidKeyCodeForHidUsage(Number(body.usage));
      if (keyCode != null) {
        inputShell.write(`input keyevent ${keyCode}`);
      }
    } else if (type === 0x07) {
      const orientation = String(body.orientation ?? "portrait") as SimulatorOrientation;
      const rotation = rotationForOrientation(orientation);
      config = { ...config, orientation };
      inputShell.write("settings put system accelerometer_rotation 0");
      inputShell.write(`settings put system user_rotation ${rotation}`);
    } else if (type === 0x09) {
      inputShell.write("am send-trim-memory com.android.systemui RUNNING_LOW");
    }
  };

  const screenrecordArgs = () => {
    const args = [
      "exec-out",
      "screenrecord",
      "--output-format=h264",
      "--bit-rate",
      String(DEFAULT_VIDEO_BIT_RATE),
      "--time-limit",
      String(SCREENRECORD_TIME_LIMIT_SECONDS),
    ];
    if (videoSize) {
      args.push("--size", `${videoSize.width}x${videoSize.height}`);
    }
    args.push("-");
    return args;
  };

  const streamH264 = (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      await refreshConfig();
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-store",
        "Connection": "keep-alive",
        "Content-Type": "video/h264",
        "X-Accel-Buffering": "no",
      });

      let closed = false;
      let child: ChildProcess | null = null;
      let restartTimer: ReturnType<typeof setTimeout> | null = null;

      const stopChild = () => {
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
        if (child && !child.killed) child.kill("SIGTERM");
        child = null;
      };

      const start = () => {
        if (closed || stopped || res.destroyed || res.writableEnded) return;
        try {
          child = adbSpawn(serial, screenrecordArgs());
        } catch (err) {
          console.error("[android-video]", err instanceof Error ? err.message : err);
          res.end();
          return;
        }

        const current = child;
        current.stdout?.on("data", (chunk: Buffer) => {
          if (closed || res.destroyed || res.writableEnded) return;
          if (!res.write(chunk)) {
            current.stdout?.pause();
            res.once("drain", () => current.stdout?.resume());
          }
        });
        current.stderr?.on("data", (chunk: Buffer) => {
          const message = chunk.toString("utf-8").trim();
          if (message) console.error("[android-video]", message);
        });
        current.on("error", (err) => {
          if (!closed) console.error("[android-video]", err.message);
        });
        current.on("close", () => {
          if (child === current) child = null;
          if (closed || stopped || res.destroyed || res.writableEnded) return;
          restartTimer = setTimeout(start, 150);
        });
      };

      req.on("close", () => {
        closed = true;
        stopChild();
      });
      start();
    })().catch((err) => {
      console.error("[android-video]", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        json(res, 503, {
          error: "video_unavailable",
          message: err instanceof Error ? err.message : String(err),
        });
      } else {
        res.end();
      }
    });
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      json(res, 200, { status: "ok", platform: "android", serial });
      return;
    }

    if (url.pathname === "/config") {
      json(res, 200, config);
      return;
    }

    if (url.pathname === "/foreground") {
      void (async () => {
        try {
          const dump = await adbText(serial, ["shell", "dumpsys", "window"], 4000);
          const bundleId = parseForegroundPackage(dump);
          let pid: number | undefined;
          if (bundleId) {
            try {
              const rawPid = (await adbText(serial, ["shell", "pidof", bundleId], 1500)).trim().split(/\s+/, 1)[0];
              pid = rawPid ? Number(rawPid) : undefined;
            } catch {}
          }
          json(res, bundleId ? 200 : 503, bundleId ? { bundleId, pid } : { error: "foreground_unavailable" });
        } catch (err) {
          json(res, 503, {
            error: "foreground_unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return;
    }

    if (url.pathname === "/ax") {
      json(res, 503, {
        error: "ax_unavailable",
        message: "Android accessibility snapshots are not available yet.",
      });
      return;
    }

    if (url.pathname === "/stream.mjpeg") {
      const raw = url.searchParams.get("raw") === "1";
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-store",
        "Connection": "keep-alive",
        "Content-Type": raw
          ? "application/octet-stream"
          : `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`,
      });
      clients.add(res);
      if (latestFrame) res.write(mjpegChunk(latestFrame));
      req.on("close", () => {
        clients.delete(res);
      });
      ensureCaptureLoop();
      return;
    }

    if (url.pathname === "/stream.h264") {
      streamH264(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  server.on("upgrade", (req, socket: Socket) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
    );
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, bytes]);
      buffer = parseWebSocketFrames(buffer, (payload, opcode) => {
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode !== 0x1 && opcode !== 0x2) return;
        try {
          handleMessage(payload);
        } catch (err) {
          console.error("[android-ws]", err instanceof Error ? err.message : err);
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      console.log(`[server] Listening on http://0.0.0.0:${port}`);
      resolve();
    });
  });

  process.on("SIGINT", () => {
    stopped = true;
    inputShell.stop();
    server.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopped = true;
    inputShell.stop();
    server.close();
    process.exit(0);
  });

  await new Promise(() => {});
}
