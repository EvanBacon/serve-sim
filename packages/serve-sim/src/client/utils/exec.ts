import { simEndpoint } from "./sim-endpoint";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Host execs ride a dedicated WebSocket (`/exec-ws`) rather than pooled
// fetches: every preview tab holds several long-lived HTTP streams (MJPEG +
// SSE), and with two or more tabs open a pooled `fetch("/exec")` queues
// behind them against the browser's six-connections-per-origin cap. The
// socket is shared per tab, authenticated with the same exec token, and any
// socket failure falls back to the POST /exec route (which also covers
// middleware mounts that don't forward upgrade events).

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
    let ready = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(execSocketUrl());
    } catch (e) {
      socketPromise = null;
      reject(e);
      return;
    }
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
        ready = true;
        openSocket = ws;
        resolve(ws);
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
      const err = new Error("exec socket closed");
      rejectAllPending(err);
      const subscriptions = [...activeSubscriptions.values()];
      activeSubscriptions.clear();
      for (const subscription of subscriptions) subscription.onEnd();
      if (!ready) reject(err);
    };
    ws.onerror = fail;
    ws.onclose = fail;
  });
  return socketPromise;
}

export interface HostEventStream {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

/**
 * EventSource-shaped subscription to one of the middleware's SSE routes,
 * carried over the shared control socket so it doesn't occupy one of the
 * browser's six pooled connections. Falls back to a real EventSource (which
 * also brings its native auto-reconnect) when the socket isn't available.
 */
export function openHostEventStream(path: string): HostEventStream {
  const stream: HostEventStream = { onmessage: null, onerror: null, close: () => {} };
  let closed = false;
  let native: EventSource | null = null;
  let subId: number | null = null;
  let sseBuffer = "";

  const fallbackToNative = () => {
    if (closed || native) return;
    subId = null;
    stream.onerror?.();
    native = new EventSource(path);
    native.onmessage = (event) => stream.onmessage?.({ data: String(event.data) });
    native.onerror = () => stream.onerror?.();
  };

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

  void (async () => {
    try {
      const ws = await openExecSocket();
      if (closed) return;
      if (ws.readyState !== WebSocket.OPEN) throw new Error("socket not open");
      subId = nextSubId++;
      activeSubscriptions.set(subId, { onData: handleChunk, onEnd: fallbackToNative });
      ws.send(JSON.stringify({ sub: subId, path }));
    } catch {
      fallbackToNative();
    }
  })();

  stream.close = () => {
    closed = true;
    native?.close();
    native = null;
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

async function socketRequest(body: Record<string, unknown>, signal?: AbortSignal): Promise<SocketReply> {
  const ws = await openExecSocket();
  if (ws.readyState !== WebSocket.OPEN) throw new Error("exec socket not open");
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

async function execViaSocket(command: string, signal?: AbortSignal): Promise<ExecResult> {
  const reply = await socketRequest({ command }, signal);
  return {
    stdout: reply.stdout ?? "",
    stderr: reply.stderr ?? "",
    exitCode: reply.exitCode ?? 1,
  };
}

async function execViaFetch(
  command: string,
  opts?: { signal?: AbortSignal },
): Promise<ExecResult> {
  const token = window.__SIM_PREVIEW__?.execToken;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(simEndpoint("exec"), {
    method: "POST",
    headers,
    body: JSON.stringify({ command }),
    signal: opts?.signal,
  });
  return res.json();
}

export async function execOnHost(
  command: string,
  opts?: { signal?: AbortSignal },
): Promise<ExecResult> {
  try {
    return await execViaSocket(command, opts?.signal);
  } catch (e) {
    // Aborts (caller timeouts) propagate; transport failures retry over HTTP.
    if (opts?.signal?.aborted) throw e;
    return execViaFetch(command, opts);
  }
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
  let reply: SocketReply;
  try {
    reply = await socketRequest({ ui: payload }, opts?.signal);
  } catch (e) {
    if (opts?.signal?.aborted) throw e;
    // Transport failure — fall back to the pooled HTTP route.
    const token = window.__SIM_PREVIEW__?.execToken;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(simEndpoint("ui-settings"), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: opts?.signal,
    });
    reply = await res.json();
  }
  if (reply.error) throw new Error(reply.error);
  return reply.status ?? null;
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
