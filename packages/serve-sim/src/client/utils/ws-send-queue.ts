export const WS_OPEN_READY_STATE = 1;

export type QueuedWsMessage = {
  tag: number;
  payload: object;
  createdAt: number;
};

export type WsSendTarget = {
  readyState: number;
  send(data: ArrayBuffer): void;
};

const DEFAULT_MAX_QUEUE_SIZE = 32;
const DEFAULT_MAX_QUEUE_AGE_MS = 1_500;

export function encodeWsMessage(tag: number, payload: object): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = tag;
  msg.set(json, 1);
  return msg;
}

export function enqueueWsMessage(
  queue: QueuedWsMessage[],
  message: QueuedWsMessage,
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
): QueuedWsMessage[] {
  const next = [...queue, message];
  return next.length > maxQueueSize ? next.slice(next.length - maxQueueSize) : next;
}

export function flushWsMessageQueue(
  ws: WsSendTarget | null | undefined,
  queue: QueuedWsMessage[],
  now = Date.now(),
  maxQueueAgeMs = DEFAULT_MAX_QUEUE_AGE_MS,
): QueuedWsMessage[] {
  const fresh = queue.filter((message) => now - message.createdAt <= maxQueueAgeMs);
  if (!ws || ws.readyState !== WS_OPEN_READY_STATE) return fresh;
  for (const message of fresh) {
    ws.send(encodeWsMessage(message.tag, message.payload).buffer);
  }
  return [];
}

export function sendOrQueueWsMessage(
  ws: WsSendTarget | null | undefined,
  queue: QueuedWsMessage[],
  tag: number,
  payload: object,
  now = Date.now(),
): QueuedWsMessage[] {
  const fresh = flushWsMessageQueue(ws, queue, now);
  if (ws?.readyState === WS_OPEN_READY_STATE) {
    ws.send(encodeWsMessage(tag, payload).buffer);
    return fresh;
  }
  return enqueueWsMessage(fresh, { tag, payload, createdAt: now });
}
