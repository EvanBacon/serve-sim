import { createServer, type ServerResponse } from "http";
import { createHash } from "crypto";
import { execFile, execFileSync } from "child_process";

import type { SimulatorOrientation } from "serve-sim-client";

export interface AndroidDevice {
  serial: string;
  state: string;
  name: string;
  model?: string;
  product?: string;
}

interface TouchPayload {
  type: "begin" | "move" | "end";
  x: number;
  y: number;
  edge?: number;
}

interface ButtonPayload {
  button: string;
}

interface KeyPayload {
  type: "down" | "up";
  usage: number;
}

interface OrientationPayload {
  orientation: SimulatorOrientation;
}

interface ScreenConfig {
  width: number;
  height: number;
  orientation: SimulatorOrientation;
}

interface AndroidAxNode {
  AXUniqueId: string | null;
  AXLabel: string | null;
  AXValue: string | null;
  enabled: boolean;
  frame: { x: number; y: number; width: number; height: number };
  role_description: string;
  type: string;
  children: AndroidAxNode[];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const DEFAULT_ANDROID_FPS = 8;

export function parseAdbDevices(output: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^List of devices attached/i.test(line)) continue;
    const parts = line.split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || !state) continue;
    const attrs = new Map<string, string>();
    for (const part of parts.slice(2)) {
      const index = part.indexOf(":");
      if (index <= 0) continue;
      attrs.set(part.slice(0, index), part.slice(index + 1));
    }
    const model = attrs.get("model");
    const product = attrs.get("product");
    devices.push({
      serial,
      state,
      model,
      product,
      name: model || product || serial,
    });
  }
  return devices;
}

export function listAndroidDevices(): AndroidDevice[] {
  const output = execFileSync("adb", ["devices", "-l"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  return parseAdbDevices(output);
}

export function getConnectedAndroidSerials(): Set<string> | null {
  try {
    return new Set(
      listAndroidDevices()
        .filter((device) => device.state === "device")
        .map((device) => device.serial),
    );
  } catch {
    return null;
  }
}

export function findConnectedAndroidDevice(): string | null {
  try {
    return listAndroidDevices().find((device) => device.state === "device")?.serial ?? null;
  } catch {
    return null;
  }
}

export function resolveAndroidDevice(nameOrSerial: string): string {
  let devices: AndroidDevice[] = [];
  try {
    devices = listAndroidDevices();
  } catch (err) {
    console.error(`Could not list Android devices with adb: ${(err as Error).message}`);
    process.exit(1);
  }

  const exact = devices.find((device) => device.serial === nameOrSerial);
  if (exact) return exact.serial;

  const lower = nameOrSerial.toLowerCase();
  const byName = devices.find((device) =>
    device.name.toLowerCase() === lower ||
    device.model?.toLowerCase() === lower ||
    device.product?.toLowerCase() === lower
  );
  if (byName) return byName.serial;

  console.error(`Could not resolve Android device: ${nameOrSerial}`);
  if (devices.length > 0) {
    console.error("Connected Android devices:");
    for (const device of devices) {
      console.error(`  ${device.serial}\t${device.state}\t${device.name}`);
    }
  }
  process.exit(1);
}

export function getAndroidDeviceName(serial: string): string | null {
  try {
    const match = listAndroidDevices().find((device) => device.serial === serial);
    if (match) return match.name;
  } catch {}
  try {
    const model = adbSync(serial, ["shell", "getprop", "ro.product.model"]).trim();
    return model || null;
  } catch {
    return null;
  }
}

export function parsePngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}

function adbSync(serial: string, args: string[]): string {
  return execFileSync("adb", ["-s", serial, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
}

function adb(serial: string, args: string[], timeout = 10_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("adb", ["-s", serial, ...args], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      timeout,
    }, (err, stdout, stderr) => {
      if (err) {
        const message = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr);
        reject(new Error(message || err.message));
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

function adbShell(serial: string, args: string[], timeout = 5_000): Promise<void> {
  return adb(serial, ["shell", ...args], timeout).then(() => {});
}

function parseWmSize(output: string): { width: number; height: number } | null {
  const match = output.match(/(?:Physical|Override) size:\s*(\d+)x(\d+)/i);
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function orientationForRotation(rotation: string | number): SimulatorOrientation {
  switch (String(rotation)) {
    case "1":
      return "landscape_left";
    case "2":
      return "portrait_upside_down";
    case "3":
      return "landscape_right";
    case "0":
    default:
      return "portrait";
  }
}

function orientationForSize({ width, height }: { width: number; height: number }): SimulatorOrientation {
  return width > height ? "landscape_left" : "portrait";
}

export function parseAndroidDisplayConfig(output: string): ScreenConfig | null {
  const match = output.match(/DisplayFrames\s+w=(\d+)\s+h=(\d+)\s+r=(\d+)/);
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    orientation: orientationForRotation(match[3]!),
  };
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return "\"";
      case "apos":
        return "'";
      default: {
        const numeric = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff
          ? String.fromCodePoint(numeric)
          : match;
      }
    }
  });
}

function parseXmlAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of source.matchAll(/([A-Za-z0-9:_-]+)="([^"]*)"/g)) {
    attrs.set(match[1]!, decodeXmlAttribute(match[2]!));
  }
  return attrs;
}

function parseAndroidBounds(value: string | undefined): AndroidAxNode["frame"] {
  const match = value?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!match) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function androidRoleForClass(className: string): string {
  const simple = className.split(".").pop() || className || "View";
  if (/button/i.test(simple)) return "Button";
  if (/edittext/i.test(simple)) return "Text Field";
  if (/checkbox/i.test(simple)) return "Checkbox";
  if (/switch/i.test(simple)) return "Switch";
  if (/radiobutton/i.test(simple)) return "Radio Button";
  if (/image/i.test(simple)) return "Image";
  if (/textview/i.test(simple)) return "Text";
  if (/list|recycler/i.test(simple)) return "List";
  if (/scroll/i.test(simple)) return "Scroll View";
  if (/progress/i.test(simple)) return "Progress Indicator";
  return simple;
}

function androidAxNodeFromAttributes(attrs: Map<string, string>): AndroidAxNode {
  const className = attrs.get("class") || "android.view.View";
  const contentDescription = attrs.get("content-desc") || "";
  const text = attrs.get("text") || "";
  const resourceId = attrs.get("resource-id") || "";
  const bounds = attrs.get("bounds") || "";
  const label = contentDescription || text || null;
  const value = text || null;
  return {
    AXUniqueId: resourceId ? `${resourceId}@${bounds}` : null,
    AXLabel: label,
    AXValue: value,
    enabled: attrs.get("enabled") !== "false",
    frame: parseAndroidBounds(bounds),
    role_description: androidRoleForClass(className),
    type: className.split(".").pop() || className,
    children: [],
  };
}

export function parseAndroidAccessibilityTree(xml: string, screen: ScreenConfig): AndroidAxNode[] {
  const start = xml.indexOf("<hierarchy");
  const end = xml.lastIndexOf("</hierarchy>");
  if (start < 0 || end < start) {
    throw new Error("uiautomator dump did not contain hierarchy XML");
  }
  const body = xml.slice(start, end + "</hierarchy>".length);
  const roots: AndroidAxNode[] = [];
  const stack: AndroidAxNode[] = [];

  for (const match of body.matchAll(/<\/node\s*>|<node\b[^>]*>/g)) {
    const token = match[0];
    if (/^<\/node\s*>$/.test(token)) {
      stack.pop();
      continue;
    }

    const isSelfClosing = /\/\s*>$/.test(token);
    const node = androidAxNodeFromAttributes(parseXmlAttributes(token));
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);

    if (!isSelfClosing) stack.push(node);
  }

  if (roots.length === 0) {
    throw new Error(`uiautomator hierarchy did not contain nodes for ${screen.width}x${screen.height}`);
  }
  return roots;
}

function clampCoordinate(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max - 1, Math.round(value * max)));
}

export function androidKeyCodeForHidUsage(usage: number): string | null {
  if (usage >= 0x04 && usage <= 0x1d) {
    return String(29 + usage - 0x04);
  }
  if (usage >= 0x1e && usage <= 0x26) {
    return String(8 + usage - 0x1e);
  }
  if (usage === 0x27) return "7";
  const map: Record<number, string> = {
    0x28: "KEYCODE_ENTER",
    0x29: "KEYCODE_ESCAPE",
    0x2a: "KEYCODE_DEL",
    0x2b: "KEYCODE_TAB",
    0x2c: "KEYCODE_SPACE",
    0x2d: "KEYCODE_MINUS",
    0x2e: "KEYCODE_EQUALS",
    0x4f: "KEYCODE_DPAD_RIGHT",
    0x50: "KEYCODE_DPAD_LEFT",
    0x51: "KEYCODE_DPAD_DOWN",
    0x52: "KEYCODE_DPAD_UP",
  };
  return map[usage] ?? null;
}

function rotationForOrientation(orientation: SimulatorOrientation): string {
  switch (orientation) {
    case "landscape_left":
      return "1";
    case "portrait_upside_down":
      return "2";
    case "landscape_right":
      return "3";
    case "portrait":
    default:
      return "0";
  }
}

async function androidScreenConfig(serial: string): Promise<ScreenConfig> {
  try {
    const display = parseAndroidDisplayConfig(adbSync(serial, ["shell", "dumpsys", "window", "displays"]));
    if (display) return display;
  } catch {}
  try {
    const frame = await adb(serial, ["exec-out", "screencap", "-p"], 8_000);
    const size = parsePngSize(frame);
    if (size) return { ...size, orientation: orientationForSize(size) };
  } catch {}
  try {
    const size = parseWmSize(adbSync(serial, ["shell", "wm", "size"]));
    if (size) return { ...size, orientation: orientationForSize(size) };
  } catch {}
  return { width: 1, height: 1, orientation: "portrait" };
}

async function androidAccessibilityTree(serial: string, screen: ScreenConfig): Promise<AndroidAxNode[]> {
  const xml = await adb(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"], 8_000)
    .then((out) => out.toString("utf-8"));
  return parseAndroidAccessibilityTree(xml, screen);
}

export async function sendAndroidButton(serial: string, button: string): Promise<void> {
  const map: Record<string, string> = {
    home: "KEYCODE_HOME",
    app_switcher: "KEYCODE_APP_SWITCH",
    back: "KEYCODE_BACK",
    lock: "KEYCODE_POWER",
    power: "KEYCODE_POWER",
  };
  const fallback = button.toUpperCase();
  const key = map[button] ?? (fallback.startsWith("KEYCODE_") ? fallback : `KEYCODE_${fallback}`);
  await adbShell(serial, ["input", "keyevent", key]);
}

export async function setAndroidOrientation(serial: string, orientation: SimulatorOrientation): Promise<void> {
  const rotation = rotationForOrientation(orientation);
  await Promise.allSettled([
    adbShell(serial, ["settings", "put", "system", "accelerometer_rotation", "0"]),
    adbShell(serial, ["settings", "put", "system", "user_rotation", rotation]),
    adbShell(serial, ["cmd", "window", "fixed-to-user-rotation", "enabled"]),
    adbShell(serial, ["cmd", "window", "set-ignore-orientation-request", "true"]),
    adbShell(serial, ["cmd", "window", "user-rotation", "lock", rotation]),
  ]);
}

class AndroidStreamServer {
  private mjpegClients = new Map<ServerResponse, { raw: boolean }>();
  private wsSockets = new Set<any>();
  private latestFrame: Buffer | null = null;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  private firstFrameLogged = false;
  private multiTouchWarningLogged = false;
  private lastScreenConfigAt = 0;
  private activeTouch: { x: number; y: number; lastX: number; lastY: number; startedAt: number } | null = null;
  private screen: ScreenConfig = { width: 0, height: 0, orientation: "portrait" };

  constructor(private serial: string, private port: number) {}

  async start(): Promise<void> {
    await this.initScreenConfig();
    const server = createServer((req, res) => {
      const rawUrl = req.url ?? "/";
      const url = rawUrl.split("?")[0];

      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }

      if (url === "/health") {
        writeJson(res, { status: "ok", platform: "android" });
        return;
      }

      if (url === "/config") {
        void this.writeConfig(res);
        return;
      }

      if (url === "/ax") {
        void this.writeAccessibilityTree(res);
        return;
      }

      if (url === "/stream.mjpeg") {
        const raw = new URL(rawUrl, `http://127.0.0.1:${this.port}`).searchParams.get("raw") === "1";
        res.writeHead(200, {
          ...corsHeaders(),
          "Content-Type": raw ? "application/octet-stream" : "multipart/x-mixed-replace; boundary=frame",
          "Cache-Control": "no-cache, no-store",
          Connection: "keep-alive",
        });
        this.mjpegClients.set(res, { raw });
        if (this.latestFrame) writeStreamFrame(res, this.latestFrame, raw);
        req.on("close", () => this.mjpegClients.delete(res));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    });

    server.on("upgrade", (req, socket) => {
      if ((req.url ?? "").split("?")[0] !== "/ws") {
        socket.destroy();
        return;
      }
      this.acceptWebSocket(req.headers["sec-websocket-key"], socket);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => resolve());
      server.listen(this.port, "0.0.0.0");
    });

    console.log(`[server] Listening on http://0.0.0.0:${this.port}`);
    this.scheduleCapture(0);

    const stop = () => {
      if (this.captureTimer) clearTimeout(this.captureTimer);
      for (const client of this.mjpegClients.keys()) client.end();
      for (const socket of this.wsSockets) socket.destroy();
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }

  private async initScreenConfig(): Promise<void> {
    await this.refreshScreenConfig(true);
  }

  private async writeConfig(res: ServerResponse): Promise<void> {
    await this.refreshScreenConfig(true);
    writeJson(res, this.screen);
  }

  private async writeAccessibilityTree(res: ServerResponse): Promise<void> {
    try {
      await this.refreshScreenConfig(true);
      writeJson(res, await androidAccessibilityTree(this.serial, this.screen));
    } catch (err) {
      writeJson(res, {
        error: "ax_unavailable",
        message: (err as Error).message || "Android accessibility snapshot failed.",
      }, 503);
    }
  }

  private async refreshScreenConfig(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastScreenConfigAt < 1000) return;
    this.lastScreenConfigAt = now;
    try {
      const next = await androidScreenConfig(this.serial);
      if (
        next.width !== this.screen.width ||
        next.height !== this.screen.height ||
        next.orientation !== this.screen.orientation
      ) {
        this.screen = next;
      }
    } catch {}
  }

  private scheduleCapture(delayMs: number): void {
    this.captureTimer = setTimeout(() => void this.captureOnce(), delayMs);
  }

  private async captureOnce(): Promise<void> {
    const started = Date.now();
    try {
      const frame = await adb(this.serial, ["exec-out", "screencap", "-p"], 8_000);
      if (frame.length > 0) {
        await this.refreshScreenConfig();
        this.latestFrame = frame;
        const size = parsePngSize(frame);
        if (size && (size.width !== this.screen.width || size.height !== this.screen.height)) {
          this.screen = { ...this.screen, ...size, orientation: orientationForSize(size) };
        }
        if (!this.firstFrameLogged) {
          this.firstFrameLogged = true;
          console.log("Capture started");
        }
        for (const [client, options] of this.mjpegClients) {
          writeStreamFrame(client, frame, options.raw);
        }
      }
    } catch (err) {
      console.error(`[android] screencap failed: ${(err as Error).message}`);
    } finally {
      const frameInterval = Math.round(1000 / DEFAULT_ANDROID_FPS);
      this.scheduleCapture(Math.max(50, frameInterval - (Date.now() - started)));
    }
  }

  private acceptWebSocket(key: string | string[] | undefined, socket: any): void {
    const wsKey = Array.isArray(key) ? key[0] : key;
    if (!wsKey) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.wsSockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const result = parseWebSocketFrames(buffer);
      buffer = result.remaining;
      for (const frame of result.frames) {
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x2) this.handleInputMessage(frame.payload);
      }
    });
    socket.on("close", () => this.wsSockets.delete(socket));
    socket.on("error", () => this.wsSockets.delete(socket));
  }

  private handleInputMessage(payload: Buffer): void {
    if (payload.length < 1) return;
    const tag = payload[0];
    const body = payload.subarray(1).toString("utf-8");
    try {
      if (tag === 0x03) this.handleTouch(JSON.parse(body) as TouchPayload);
      else if (tag === 0x04) this.handleButton(JSON.parse(body) as ButtonPayload);
      else if (tag === 0x05) this.handleUnsupportedMultiTouch();
      else if (tag === 0x06) this.handleKey(JSON.parse(body) as KeyPayload);
      else if (tag === 0x07) this.handleOrientation(JSON.parse(body) as OrientationPayload);
    } catch (err) {
      console.error(`[android] failed to handle input: ${(err as Error).message}`);
    }
  }

  private handleTouch(touch: TouchPayload): void {
    const width = this.screen.width || 1;
    const height = this.screen.height || 1;
    const x = clampCoordinate(touch.x, width);
    const y = clampCoordinate(touch.y, height);
    if (touch.type === "begin") {
      this.activeTouch = { x, y, lastX: x, lastY: y, startedAt: Date.now() };
      return;
    }
    if (touch.type === "move") {
      if (this.activeTouch) {
        this.activeTouch.lastX = x;
        this.activeTouch.lastY = y;
      }
      return;
    }

    const start = this.activeTouch ?? { x, y, lastX: x, lastY: y, startedAt: Date.now() };
    this.activeTouch = null;
    const endX = x;
    const endY = y;
    const distance = Math.hypot(endX - start.x, endY - start.y);
    if (distance < 12) {
      void adbShell(this.serial, ["input", "tap", String(endX), String(endY)]).catch(console.error);
      return;
    }
    const duration = Math.max(80, Math.min(1500, Date.now() - start.startedAt));
    void adbShell(this.serial, [
      "input",
      "touchscreen",
      "swipe",
      String(start.x),
      String(start.y),
      String(endX),
      String(endY),
      String(duration),
    ]).catch(console.error);
  }

  private handleUnsupportedMultiTouch(): void {
    if (this.multiTouchWarningLogged) return;
    this.multiTouchWarningLogged = true;
    console.warn("[android] Multi-touch gestures are not supported by adb input.");
  }

  private handleButton({ button }: ButtonPayload): void {
    void sendAndroidButton(this.serial, button).catch(console.error);
  }

  private handleKey({ type, usage }: KeyPayload): void {
    if (type !== "down") return;
    const key = androidKeyCodeForHidUsage(usage);
    if (!key) return;
    void adbShell(this.serial, ["input", "keyevent", key]).catch(console.error);
  }

  private handleOrientation({ orientation }: OrientationPayload): void {
    this.screen = { ...this.screen, orientation };
    void setAndroidOrientation(this.serial, orientation).catch(() => {});
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function writeJson(res: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json",
    "Cache-Control": "no-cache, no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeMultipartFrame(res: ServerResponse, frame: Buffer): void {
  const header =
    `--frame\r\nContent-Type: image/png\r\nContent-Length: ${frame.length}\r\n\r\n`;
  res.write(header);
  res.write(frame);
  res.write("\r\n");
}

function writeStreamFrame(res: ServerResponse, frame: Buffer, raw: boolean): void {
  if (raw) {
    res.write(frame);
    return;
  }
  writeMultipartFrame(res, frame);
}

function parseWebSocketFrames(buffer: Buffer): {
  frames: Array<{ opcode: number; payload: Buffer }>;
  remaining: Buffer;
} {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
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
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { frames, remaining: Buffer.alloc(0) };
      }
      length = Number(bigLength);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;

    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = payload[i]! ^ mask[i % 4]!;
      }
    }
    frames.push({ opcode, payload });
    offset += frameLength;
  }

  return { frames, remaining: buffer.subarray(offset) };
}

export async function runAndroidHelper(serial: string, port: number): Promise<void> {
  const state = await adb(serial, ["get-state"], 5_000).then((out) => out.toString("utf-8").trim());
  if (state !== "device") {
    throw new Error(`Android device ${serial} is not ready (adb state: ${state || "unknown"})`);
  }
  await new AndroidStreamServer(serial, port).start();
}
