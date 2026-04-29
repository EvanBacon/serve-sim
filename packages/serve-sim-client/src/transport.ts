import { defineCommand } from "just-bash";
import type { ClientMessage, ServerMessage } from "./types";
import { encodeSingleTouch, encodeMultiTouch } from "./touch-codec";

export type { ClientMessage, ServerMessage } from "./types";
export { encodeSingleTouch, encodeMultiTouch, decodeTouchMessage, isBinaryTouchMessage } from "./touch-codec";
export type { SingleTouchData, MultiTouchData, DecodedSingleTouch, DecodedMultiTouch } from "./touch-codec";

export interface HeartbeatConfig {
  /** Interval between ping messages in ms (default: 25000). */
  intervalMs?: number;
  /** Time to wait for pong before considering connection dead in ms (default: 10000). */
  timeoutMs?: number;
}

export interface GatewayTransportOptions {
  url: string;
  token?: string;
  /** Enable heartbeat keepalive. Defaults to enabled with 25s interval / 10s timeout. Set to false to disable. */
  heartbeat?: boolean | HeartbeatConfig;
  /**
   * Inactivity timeout (ms) for `writeFile`/`readFile`. Reset on every chunk
   * received. Defaults to 30s. A gateway that silently drops file messages
   * (e.g. an old version with no file handler) will trigger this rather than
   * hang forever.
   */
  fileOpTimeoutMs?: number;
}

interface PendingExec {
  stdoutChunks: string[];
  stderrChunks: string[];
  resolve: (result: { stdout: string; stderr: string; exitCode: number }) => void;
  reject: (error: Error) => void;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

interface PendingFile {
  dataChunks: string[];
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
  /** Inactivity watchdog — reset on every received chunk/ack. */
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  /** Human-readable description for timeout error messages. */
  description: string;
}

/** Default inactivity timeout for file ops. Override per-instance via GatewayTransportOptions.fileOpTimeoutMs. */
const DEFAULT_FILE_OP_TIMEOUT_MS = 30_000;

/** Listener receives a blob URL (object URL) pointing to the JPEG frame data. */
export type StreamFrameListener = (blobUrl: string) => void;
export type StreamConfigListener = (config: { width: number; height: number }) => void;
export type ConnectionQuality = "good" | "degraded" | "poor";
export type ConnectionQualityListener = (quality: ConnectionQuality) => void;

/** Number of recent frame inter-arrival times to average for quality measurement. */
const QUALITY_WINDOW_SIZE = 10;
/** Thresholds (ms) for connection quality classification. */
const QUALITY_GOOD_MS = 100;
const QUALITY_DEGRADED_MS = 250;

// ─── Heartbeat defaults ───
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

/** Minimum interval (ms) between sending consecutive move events. */
const TOUCH_THROTTLE_MS = 30;
/** Drop move events when WebSocket send buffer exceeds this many bytes. */
const BACKPRESSURE_BYTES = 4096;

// ─── Adaptive frame rate constants ───
/** Buffer threshold (bytes) above which we consider the network congested. */
const ADAPTIVE_HIGH_WATER = 8192;
/** Buffer threshold (bytes) below which we consider the network healthy. */
const ADAPTIVE_LOW_WATER = 1024;
/** How many consecutive high-water frames before we degrade FPS. */
const ADAPTIVE_DEGRADE_COUNT = 3;
/** How many consecutive low-water frames before we recover FPS. */
const ADAPTIVE_RECOVER_COUNT = 10;
/** Minimum FPS we'll degrade to. */
const ADAPTIVE_MIN_FPS = 5;
/** Maximum FPS we'll recover to. */
const ADAPTIVE_MAX_FPS = 30;
/** FPS increment when recovering. */
const ADAPTIVE_RECOVER_STEP = 5;

export type AdaptiveState = "normal" | "degraded";

export type AdaptiveFpsListener = (fps: number, state: AdaptiveState) => void;

interface PendingMove<T> {
  data: T;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayTransport {
  private ws: WebSocket;
  private pending = new Map<string, PendingExec>();
  private pendingFiles = new Map<string, PendingFile>();
  private ready: Promise<void>;
  private streamFrameListeners = new Set<StreamFrameListener>();
  private streamConfigListeners = new Set<StreamConfigListener>();
  private adaptiveFpsListeners = new Set<AdaptiveFpsListener>();
  private connectionQualityListeners = new Set<ConnectionQualityListener>();

  // Adaptive frame rate state
  private _adaptiveState: AdaptiveState = "normal";
  private _currentFps: number = ADAPTIVE_MAX_FPS;
  private _highWaterCount = 0;
  private _lowWaterCount = 0;

  // Connection quality tracking
  private lastFrameTime: number | null = null;
  private frameIntervals: number[] = [];
  private currentQuality: ConnectionQuality | null = null;

  // Heartbeat state
  private _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private _heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private _heartbeatIntervalMs: number;
  private _heartbeatTimeoutMs: number;
  private _heartbeatEnabled: boolean;
  private _lastMessageTime: number = 0;

  // File transfer inactivity timeout
  private _fileOpTimeoutMs: number;

  // Touch throttle state
  private touchSeq = 0;
  private lastTouchSendTime = 0;
  private pendingTouch: PendingMove<{ type: "begin" | "move" | "end"; x: number; y: number; edge?: number }> | null = null;
  private multiTouchSeq = 0;
  private lastMultiTouchSendTime = 0;
  private pendingMultiTouch: PendingMove<{ type: "begin" | "move" | "end"; x1: number; y1: number; x2: number; y2: number }> | null = null;

  constructor(options: GatewayTransportOptions) {
    this._fileOpTimeoutMs = options.fileOpTimeoutMs ?? DEFAULT_FILE_OP_TIMEOUT_MS;

    // Heartbeat configuration
    const hb = options.heartbeat;
    if (hb === false) {
      this._heartbeatEnabled = false;
      this._heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
      this._heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS;
    } else {
      this._heartbeatEnabled = true;
      const config = typeof hb === "object" ? hb : {};
      this._heartbeatIntervalMs = config.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
      this._heartbeatTimeoutMs = config.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    }

    // Browsers don't support custom headers on WebSocket.
    // Use query param for browser auth, headers for Node/Bun.
    const isBrowser = typeof window !== "undefined";

    let url = options.url;
    if (isBrowser && options.token) {
      const u = new URL(options.url);
      if (!u.searchParams.has("token")) {
        u.searchParams.set("token", options.token);
      }
      url = u.toString();
    }

    if (!isBrowser && options.token) {
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${options.token}` },
      } as any);
    } else {
      this.ws = new WebSocket(url);
    }

    // Request binary messages as ArrayBuffer so we can handle binary frames
    this.ws.binaryType = "arraybuffer";

    let _opened = false;
    let _lastErrorDetail: string | null = null;

    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => {
        _opened = true;
        this._startHeartbeat();
        resolve();
      };

      this.ws.onerror = (e: any) => {
        // Capture whatever context the runtime gives us. Browser WS errors
        // carry very little info, but Bun/ws in Node may expose .message or
        // .error on the event.
        const parts: string[] = [];
        if (e?.message) parts.push(e.message);
        if (e?.error?.message && e.error.message !== e?.message) parts.push(e.error.message);
        if (e?.error?.code) parts.push(`code=${e.error.code}`);
        if (typeof e === "string") parts.push(e);
        _lastErrorDetail = parts.join(" ") || null;
      };

      this.ws.onclose = (ev: any) => {
        this._stopHeartbeat();

        if (!_opened) {
          const code = typeof ev?.code === "number" ? ev.code : undefined;
          const reason = typeof ev?.reason === "string" && ev.reason ? ev.reason : undefined;
          const bits = [
            "WebSocket connection failed",
            _lastErrorDetail,
            code !== undefined ? `close=${code}` : null,
            reason ? `reason=${reason}` : null,
          ].filter(Boolean);
          reject(new Error(bits.join(" ")));
        }

        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(new Error("WebSocket closed"));
        }
        for (const [id, p] of this.pendingFiles) {
          this._clearFileInactivityTimer(p);
          this.pendingFiles.delete(id);
          p.reject(new Error("WebSocket closed"));
        }
      };
    });

    this.ws.onmessage = (event) => {
      // ── Binary message: frame data ──
      if (event.data instanceof ArrayBuffer) {
        this._lastMessageTime = Date.now();
        const buf = event.data as ArrayBuffer;
        if (buf.byteLength < 1) return;
        const view = new Uint8Array(buf);
        const msgType = view[0];
        if (msgType === 0x01) {
          // Frame: [0x01][JPEG bytes]
          this._trackFrameTiming();
          const jpegData = buf.slice(1);
          const blob = new Blob([jpegData], { type: "image/jpeg" });
          const blobUrl = URL.createObjectURL(blob);
          this._checkAdaptiveFps();
          for (const listener of this.streamFrameListeners) {
            listener(blobUrl);
          }
        }
        return;
      }

      this._lastMessageTime = Date.now();

      let parsed: any;
      try {
        parsed = JSON.parse(
          typeof event.data === "string" ? event.data : event.data.toString()
        );
      } catch {
        return;
      }

      // Handle heartbeat pong
      if (parsed.type === "pong") {
        this._clearHeartbeatTimeout();
        return;
      }

      // Handle relay control messages (from cloud relay Durable Object)
      if (parsed.type === "relay:error" || parsed.type === "relay:upstream_disconnected") {
        const error = parsed.error ?? "Gateway disconnected";
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(new Error(error));
        }
        for (const [id, p] of this.pendingFiles) {
          this._clearFileInactivityTimer(p);
          this.pendingFiles.delete(id);
          p.reject(new Error(error));
        }
        return;
      }
      if (parsed.type === "relay:connected") return;

      // Handle stream messages (backward-compatible JSON path)
      if (parsed.type === "stream:frame") {
        this._trackFrameTiming();
        // Legacy base64 JSON frame — convert to blob URL for consistency
        const binary = Uint8Array.from(atob(parsed.data), (c) => c.charCodeAt(0));
        const blob = new Blob([binary], { type: "image/jpeg" });
        const blobUrl = URL.createObjectURL(blob);
        for (const listener of this.streamFrameListeners) {
          listener(blobUrl);
        }
        this._checkAdaptiveFps();
        return;
      }
      if (parsed.type === "stream:config") {
        for (const listener of this.streamConfigListeners) {
          listener(parsed.data);
        }
        return;
      }

      const msg = parsed as ServerMessage;

      if (msg.type === "file:data" || msg.type === "file:done" || msg.type === "file:error") {
        const pf = this.pendingFiles.get(msg.id);
        if (!pf) return;
        this._resetFileInactivityTimer(msg.id, pf);
        if (msg.type === "file:data") {
          pf.dataChunks.push(msg.data);
        } else if (msg.type === "file:done") {
          this._clearFileInactivityTimer(pf);
          this.pendingFiles.delete(msg.id);
          const joined = pf.dataChunks.join("");
          if (joined.length === 0) {
            pf.resolve(new Uint8Array(0));
          } else if (typeof Buffer !== "undefined") {
            pf.resolve(new Uint8Array(Buffer.from(joined, "base64")));
          } else {
            const binary = atob(joined);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            pf.resolve(bytes);
          }
        } else {
          this._clearFileInactivityTimer(pf);
          this.pendingFiles.delete(msg.id);
          pf.reject(new Error(msg.error));
        }
        return;
      }

      const pending = this.pending.get(msg.id);
      if (!pending) return;

      switch (msg.type) {
        case "exec:stdout":
          pending.stdoutChunks.push(msg.data);
          pending.onStdout?.(msg.data);
          break;
        case "exec:stderr":
          pending.stderrChunks.push(msg.data);
          pending.onStderr?.(msg.data);
          break;
        case "exec:done":
          this.pending.delete(msg.id);
          pending.resolve({
            stdout: pending.stdoutChunks.join(""),
            stderr: pending.stderrChunks.join(""),
            exitCode: msg.exitCode,
          });
          break;
        case "exec:error":
          this.pending.delete(msg.id);
          pending.reject(new Error(msg.error));
          break;
      }
    };
  }

  async waitForOpen(): Promise<void> {
    await this.ready;
  }

  exec(
    command: string,
    args: string[],
    options?: { onStdout?: (data: string) => void; onStderr?: (data: string) => void }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.pending.set(id, {
        stdoutChunks: [],
        stderrChunks: [],
        resolve,
        reject,
        onStdout: options?.onStdout,
        onStderr: options?.onStderr,
      });

      const msg: ClientMessage = { type: "exec", id, command, args };
      this.ws.send(JSON.stringify(msg));
    });
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();

      const pendingDone = new Promise<void>((res, rej) => {
        const pf: PendingFile = {
          dataChunks: [],
          resolve: () => res(),
          reject: rej,
          inactivityTimer: null,
          description: `writeFile(${path})`,
        };
        this.pendingFiles.set(id, pf);
        this._resetFileInactivityTimer(id, pf);
      });

      const RAW_CHUNK = 36 * 1024; // 36KB raw -> 48KB base64
      const totalChunks = Math.max(1, Math.ceil(data.byteLength / RAW_CHUNK));

      for (let i = 0; i < totalChunks; i++) {
        const start = i * RAW_CHUNK;
        const end = Math.min(start + RAW_CHUNK, data.byteLength);
        const chunk = data.subarray(start, end);
        const isFinal = i === totalChunks - 1;

        let b64: string;
        if (typeof Buffer !== "undefined") {
          b64 = Buffer.from(chunk).toString("base64");
        } else {
          let binary = "";
          for (let j = 0; j < chunk.byteLength; j++) binary += String.fromCharCode(chunk[j]!);
          b64 = btoa(binary);
        }

        const msg: ClientMessage = { type: "file:write", id, path, data: b64, final: isFinal };
        this.ws.send(JSON.stringify(msg));
      }

      pendingDone.then(resolve, reject);
    });
  }

  readFile(path: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const pf: PendingFile = {
        dataChunks: [],
        resolve,
        reject,
        inactivityTimer: null,
        description: `readFile(${path})`,
      };
      this.pendingFiles.set(id, pf);
      this._resetFileInactivityTimer(id, pf);
      const msg: ClientMessage = { type: "file:read", id, path };
      this.ws.send(JSON.stringify(msg));
    });
  }

  private _resetFileInactivityTimer(id: string, pf: PendingFile): void {
    if (pf.inactivityTimer) clearTimeout(pf.inactivityTimer);
    pf.inactivityTimer = setTimeout(() => {
      // Check we still own the entry — a concurrent done/error may have
      // raced us between the timer firing and this callback running.
      if (this.pendingFiles.get(id) !== pf) return;
      this.pendingFiles.delete(id);
      pf.reject(
        new Error(
          `${pf.description} timed out: no response from gateway for ${this._fileOpTimeoutMs}ms. ` +
            `The gateway may be running an older version that does not support file transfers, ` +
            `or the connection may be silently dropping messages.`,
        ),
      );
    }, this._fileOpTimeoutMs);
  }

  private _clearFileInactivityTimer(pf: PendingFile): void {
    if (pf.inactivityTimer) {
      clearTimeout(pf.inactivityTimer);
      pf.inactivityTimer = null;
    }
  }

  bridge(commandName: string) {
    const self = this;
    return defineCommand(commandName, async (args: string[]) => {
      const result = await self.exec(commandName, args);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    });
  }

  // ─── Stream API ───

  streamStart(options?: { maxFps?: number; device?: string }): void {
    const fps = options?.maxFps ?? ADAPTIVE_MAX_FPS;
    this._currentFps = fps;
    this._adaptiveState = "normal";
    this._highWaterCount = 0;
    this._lowWaterCount = 0;
    const msg: any = { type: "stream:start" };
    if (options?.maxFps) msg.maxFps = options.maxFps;
    if (options?.device) msg.device = options.device;
    this.ws.send(JSON.stringify(msg));
  }

  streamStop(device?: string): void {
    const msg: any = { type: "stream:stop" };
    if (device) msg.device = device;
    this.ws.send(JSON.stringify(msg));
  }

  streamSetFps(maxFps: number, device?: string): void {
    const msg: any = { type: "stream:set-fps", maxFps };
    if (device) msg.device = device;
    this.ws.send(JSON.stringify(msg));
  }

  streamTouch(data: { type: "begin" | "move" | "end"; x: number; y: number; edge?: number }, device?: string): void {
    if (data.type === "end") {
      // Flush the pending move BEFORE we allocate `end`'s seq. The flushed
      // move keeps whatever seq the buffered move owned, and `end` gets the
      // next one — guaranteeing strict monotonic ordering on the wire.
      this._flushPendingTouch();
      const seq = ++this.touchSeq;
      this.ws.send(encodeSingleTouch(data, seq));
      return;
    }

    const seq = ++this.touchSeq;

    if (data.type === "begin") {
      this._cancelPendingTouch();
      this.lastTouchSendTime = Date.now();
      this.ws.send(encodeSingleTouch(data, seq));
      return;
    }

    // move: throttle with latest-wins
    if (this._isBackpressured()) {
      // Network congested — replace pending or skip entirely
      if (this.pendingTouch) {
        this.pendingTouch.data = data;
      }
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastTouchSendTime;

    if (elapsed >= TOUCH_THROTTLE_MS) {
      // Enough time passed — send immediately
      this._cancelPendingTouch();
      this.lastTouchSendTime = now;
      this.ws.send(encodeSingleTouch(data, seq));
    } else {
      // Too soon — buffer this move (replacing any previous pending move)
      if (this.pendingTouch) {
        this.pendingTouch.data = data;
      } else {
        const delay = TOUCH_THROTTLE_MS - elapsed;
        this.pendingTouch = {
          data,
          timer: setTimeout(() => {
            const pending = this.pendingTouch;
            this.pendingTouch = null;
            if (pending) {
              this.lastTouchSendTime = Date.now();
              this.ws.send(encodeSingleTouch(pending.data, this.touchSeq));
            }
          }, delay),
        };
      }
    }
  }

  streamMultiTouch(data: { type: "begin" | "move" | "end"; x1: number; y1: number; x2: number; y2: number }, device?: string): void {
    if (data.type === "end") {
      // Same seq-allocation ordering as streamTouch — flush first, then
      // give `end` the next seq so the two events can't collide.
      this._flushPendingMultiTouch();
      const seq = ++this.multiTouchSeq;
      this.ws.send(encodeMultiTouch(data, seq));
      return;
    }

    const seq = ++this.multiTouchSeq;

    if (data.type === "begin") {
      this._cancelPendingMultiTouch();
      this.lastMultiTouchSendTime = Date.now();
      this.ws.send(encodeMultiTouch(data, seq));
      return;
    }

    // move: throttle with latest-wins
    if (this._isBackpressured()) {
      if (this.pendingMultiTouch) {
        this.pendingMultiTouch.data = data;
      }
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastMultiTouchSendTime;

    if (elapsed >= TOUCH_THROTTLE_MS) {
      this._cancelPendingMultiTouch();
      this.lastMultiTouchSendTime = now;
      this.ws.send(encodeMultiTouch(data, seq));
    } else {
      if (this.pendingMultiTouch) {
        this.pendingMultiTouch.data = data;
      } else {
        const delay = TOUCH_THROTTLE_MS - elapsed;
        this.pendingMultiTouch = {
          data,
          timer: setTimeout(() => {
            const pending = this.pendingMultiTouch;
            this.pendingMultiTouch = null;
            if (pending) {
              this.lastMultiTouchSendTime = Date.now();
              this.ws.send(encodeMultiTouch(pending.data, this.multiTouchSeq));
            }
          }, delay),
        };
      }
    }
  }

  streamButton(button: string, device?: string): void {
    const msg: any = { type: "stream:button", data: { button } };
    if (device) msg.device = device;
    this.ws.send(JSON.stringify(msg));
  }

  // ─── Throttle helpers ───

  private _isBackpressured(): boolean {
    return this.ws.bufferedAmount > BACKPRESSURE_BYTES;
  }

  private _cancelPendingTouch(): void {
    if (this.pendingTouch) {
      clearTimeout(this.pendingTouch.timer);
      this.pendingTouch = null;
    }
  }

  private _flushPendingTouch(): void {
    if (this.pendingTouch) {
      clearTimeout(this.pendingTouch.timer);
      const pending = this.pendingTouch;
      this.pendingTouch = null;
      this.lastTouchSendTime = Date.now();
      this.ws.send(encodeSingleTouch(pending.data, this.touchSeq));
    }
  }

  private _cancelPendingMultiTouch(): void {
    if (this.pendingMultiTouch) {
      clearTimeout(this.pendingMultiTouch.timer);
      this.pendingMultiTouch = null;
    }
  }

  private _flushPendingMultiTouch(): void {
    if (this.pendingMultiTouch) {
      clearTimeout(this.pendingMultiTouch.timer);
      const pending = this.pendingMultiTouch;
      this.pendingMultiTouch = null;
      this.lastMultiTouchSendTime = Date.now();
      this.ws.send(encodeMultiTouch(pending.data, this.multiTouchSeq));
    }
  }

  onStreamFrame(listener: StreamFrameListener): () => void {
    this.streamFrameListeners.add(listener);
    return () => { this.streamFrameListeners.delete(listener); };
  }

  onStreamConfig(listener: StreamConfigListener): () => void {
    this.streamConfigListeners.add(listener);
    return () => { this.streamConfigListeners.delete(listener); };
  }

  onAdaptiveFps(listener: AdaptiveFpsListener): () => void {
    this.adaptiveFpsListeners.add(listener);
    return () => { this.adaptiveFpsListeners.delete(listener); };
  }

  get adaptiveFps(): number {
    return this._currentFps;
  }

  get adaptiveState(): AdaptiveState {
    return this._adaptiveState;
  }

  /** Called after every received frame to adjust FPS based on backpressure. */
  private _checkAdaptiveFps(): void {
    const buffered = this.ws.bufferedAmount;

    if (buffered > ADAPTIVE_HIGH_WATER) {
      this._lowWaterCount = 0;
      this._highWaterCount++;
      if (this._highWaterCount >= ADAPTIVE_DEGRADE_COUNT && this._currentFps > ADAPTIVE_MIN_FPS) {
        const newFps = Math.max(ADAPTIVE_MIN_FPS, Math.floor(this._currentFps / 2));
        if (newFps !== this._currentFps) {
          this._currentFps = newFps;
          this._adaptiveState = "degraded";
          this._highWaterCount = 0;
          this.streamSetFps(newFps);
          this._notifyAdaptiveFps();
        }
      }
    } else if (buffered < ADAPTIVE_LOW_WATER) {
      this._highWaterCount = 0;
      this._lowWaterCount++;
      if (this._lowWaterCount >= ADAPTIVE_RECOVER_COUNT && this._currentFps < ADAPTIVE_MAX_FPS) {
        const newFps = Math.min(ADAPTIVE_MAX_FPS, this._currentFps + ADAPTIVE_RECOVER_STEP);
        if (newFps !== this._currentFps) {
          this._currentFps = newFps;
          if (newFps >= ADAPTIVE_MAX_FPS) this._adaptiveState = "normal";
          this._lowWaterCount = 0;
          this.streamSetFps(newFps);
          this._notifyAdaptiveFps();
        }
      }
    } else {
      // In between — reset both counters
      this._highWaterCount = 0;
      this._lowWaterCount = 0;
    }
  }

  private _notifyAdaptiveFps(): void {
    for (const listener of this.adaptiveFpsListeners) {
      listener(this._currentFps, this._adaptiveState);
    }
  }

  // ─── Connection quality ───

  private _trackFrameTiming(): void {
    const now = Date.now();
    if (this.lastFrameTime !== null) {
      const interval = now - this.lastFrameTime;
      this.frameIntervals.push(interval);
      if (this.frameIntervals.length > QUALITY_WINDOW_SIZE) {
        this.frameIntervals.shift();
      }
      const newQuality = this._computeQuality();
      if (newQuality !== this.currentQuality) {
        this.currentQuality = newQuality;
        for (const listener of this.connectionQualityListeners) {
          listener(newQuality);
        }
      }
    }
    this.lastFrameTime = now;
  }

  private _computeQuality(): ConnectionQuality {
    if (this.frameIntervals.length === 0) return "good";
    const sum = this.frameIntervals.reduce((a, b) => a + b, 0);
    const avg = sum / this.frameIntervals.length;
    if (avg <= QUALITY_GOOD_MS) return "good";
    if (avg <= QUALITY_DEGRADED_MS) return "degraded";
    return "poor";
  }

  getConnectionQuality(): ConnectionQuality | null {
    return this.currentQuality;
  }

  onConnectionQualityChange(listener: ConnectionQualityListener): () => void {
    this.connectionQualityListeners.add(listener);
    return () => { this.connectionQualityListeners.delete(listener); };
  }

  // ─── Heartbeat ───

  private _startHeartbeat(): void {
    if (!this._heartbeatEnabled) return;
    this._lastMessageTime = Date.now();
    this._heartbeatInterval = setInterval(() => {
      this._sendPing();
    }, this._heartbeatIntervalMs);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    this._clearHeartbeatTimeout();
  }

  private _sendPing(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "ping" }));
    // Start timeout waiting for pong (or any message)
    if (!this._heartbeatTimeout) {
      this._heartbeatTimeout = setTimeout(() => {
        this._heartbeatTimeout = null;
        // No response received — connection is dead
        this.ws.close(4000, "heartbeat timeout");
      }, this._heartbeatTimeoutMs);
    }
  }

  private _clearHeartbeatTimeout(): void {
    if (this._heartbeatTimeout) {
      clearTimeout(this._heartbeatTimeout);
      this._heartbeatTimeout = null;
    }
  }

  close(): void {
    this._stopHeartbeat();
    this._cancelPendingTouch();
    this._cancelPendingMultiTouch();
    this.ws.close();
  }
}

export async function createGatewayTransport(
  options: GatewayTransportOptions
): Promise<GatewayTransport> {
  const transport = new GatewayTransport(options);
  await transport.waitForOpen();
  return transport;
}
