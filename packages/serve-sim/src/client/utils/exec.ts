import { simEndpoint } from "./sim-endpoint";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Everything the preview page asks of the host — shell execs, simulator
// settings, and the SSE side-channels — rides one WebSocket (`/exec-ws`).
// Pooled fetches are not used: every tab holds long-lived HTTP streams
// (MJPEG), and the browser's six-connections-per-origin cap let pooled
// requests starve with multiple tabs open. The channel is intentionally
// WS-only with no HTTP fallback — a broken socket surfaces as an error
// instead of silently degrading back into the starvation it exists to fix.

const CONNECT_TIMEOUT_MS = 5_000;
const STREAM_RETRY_MS = 2_000;

type SocketReply = {
  id?: number;
  sub?: number;
  data?: string;
  end?: boolean;
  ready?: boolean;
  error?: string;
} & Partial<ExecResult> & { status?: Record<string, string>; ok?: boolean };

interface PendingRequest {
  resolve: (reply: SocketReply) => void;
  reject: (err: unknown) => void;
}

interface ActiveSubscription {
  onData: (chunk: string) => void;
  onEnd: () => void;
}

let socketPromise: Promise<WebSocket> | null = null;
let openSocket: WebSocket | null = null;
let nextRequestId = 1;
let nextSubId = 1;
const pendingRequests = new Map<number, PendingRequest>();
const activeSubscriptions = new Map<number, ActiveSubscription>();

function execSocketUrl(): string {
  const url = new URL(simEndpoint("exec-ws"), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function rejectAllPending(reason: Error): void {
  for (const pending of pendingRequests.values()) pending.reject(reason);
  pendingRequests.clear();
}

function openExecSocket(): Promise<WebSocket> {
  socketPromise ??= new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(execSocketUrl());
    } catch (e) {
      socketPromise = null;
      reject(e);
      return;
    }
    // Fail fast if the server never completes the handshake or auth — a
    // hung connection must not stall every request behind it.
    const connectTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socketPromise = null;
        reject(new Error("control socket connect timeout"));
        ws.close();
      }
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      ws.send(JSON.stringify({ token: window.__SIM_PREVIEW__?.execToken ?? "" }));
    };
    ws.onmessage = (event) => {
      let msg: SocketReply;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.ready) {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          openSocket = ws;
          resolve(ws);
        }
        return;
      }
      if (typeof msg.sub === "number") {
        const subscription = activeSubscriptions.get(msg.sub);
        if (!subscription) return;
        if (msg.end) {
          activeSubscriptions.delete(msg.sub);
          subscription.onEnd();
        } else if (typeof msg.data === "string") {
          subscription.onData(msg.data);
        }
        return;
      }
      if (typeof msg.id !== "number") return;
      const pending = pendingRequests.get(msg.id);
      if (!pending) return;
      pendingRequests.delete(msg.id);
      pending.resolve(msg);
    };
    const fail = () => {
      socketPromise = null;
      openSocket = null;
      const err = new Error("control socket closed — reload the page if this persists");
      rejectAllPending(err);
      const subscriptions = [...activeSubscriptions.values()];
      activeSubscriptions.clear();
      for (const subscription of subscriptions) subscription.onEnd();
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(err);
      }
    };
    ws.onerror = fail;
    ws.onclose = fail;
  });
  return socketPromise;
}

async function socketRequest(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SocketReply> {
  const ws = await openExecSocket();
  if (ws.readyState !== WebSocket.OPEN) throw new Error("control socket not open");
  return new Promise<SocketReply>((resolve, reject) => {
    const id = nextRequestId++;
    const onAbort = () => {
      pendingRequests.delete(id);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    pendingRequests.set(id, {
      resolve: (reply) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(reply);
      },
      reject: (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    });
    ws.send(JSON.stringify({ id, ...body }));
  });
}

export async function execOnHost(
  command: string,
  opts?: { signal?: AbortSignal },
): Promise<ExecResult> {
  const reply = await socketRequest({ command }, opts?.signal);
  return {
    stdout: reply.stdout ?? "",
    stderr: reply.stderr ?? "",
    exitCode: reply.exitCode ?? 1,
  };
}

export interface UiRequestPayload {
  device: string;
  option?: string;
  value?: string;
}

/**
 * Simulator-settings request, handled in-process by the preview server (just
 * the underlying simctl/ax-tool spawn — no `node <cli>` shell round-trip).
 * Resolves to the settings map for status requests; rejects with the server's
 * error message for invalid requests or failed sets.
 */
export async function hostUiRequest(
  payload: UiRequestPayload,
  opts?: { signal?: AbortSignal },
): Promise<Record<string, string> | null> {
  const reply = await socketRequest({ ui: payload }, opts?.signal);
  if (reply.error) throw new Error(reply.error);
  return reply.status ?? null;
}

export interface HostEventStream {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

/**
 * EventSource-shaped subscription to one of the middleware's SSE routes,
 * carried over the shared control socket. Resubscribes (with backoff) when
 * the socket drops or the upstream ends, mirroring EventSource's native
 * auto-reconnect; `onerror` fires on each interruption.
 */
export function openHostEventStream(path: string): HostEventStream {
  const stream: HostEventStream = { onmessage: null, onerror: null, close: () => {} };
  let closed = false;
  let subId: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let sseBuffer = "";

  const handleChunk = (chunk: string) => {
    sseBuffer += chunk.replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = sseBuffer.indexOf("\n\n")) !== -1) {
      const block = sseBuffer.slice(0, boundary);
      sseBuffer = sseBuffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) stream.onmessage?.({ data });
    }
  };

  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    stream.onerror?.();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void subscribe();
    }, STREAM_RETRY_MS);
  };

  const subscribe = async () => {
    if (closed) return;
    try {
      const ws = await openExecSocket();
      if (closed) return;
      sseBuffer = "";
      subId = nextSubId++;
      activeSubscriptions.set(subId, { onData: handleChunk, onEnd: scheduleRetry });
      ws.send(JSON.stringify({ sub: subId, path }));
    } catch {
      scheduleRetry();
    }
  };

  void subscribe();

  stream.close = () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (subId !== null) {
      activeSubscriptions.delete(subId);
      try {
        openSocket?.send(JSON.stringify({ unsub: subId }));
      } catch {}
      subId = null;
    }
  };
  return stream;
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
