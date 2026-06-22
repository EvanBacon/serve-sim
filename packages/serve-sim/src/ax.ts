import { AX_UNAVAILABLE_ERROR } from "./ax-shared";
import type { AxElement, AxRect, AxSnapshot } from "./ax-shared";
import { axDescribeAsync } from "./native";

export type { AxElement, AxRect, AxSnapshot } from "./ax-shared";

const MAX_ELEMENTS = 500;
const POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 2000;
const UNAVAILABLE_RETRY_INTERVAL_MS = 15_000;

interface RawAxeNode {
  AXUniqueId: string | null;
  AXLabel: string | null;
  AXValue: string | null;
  enabled: boolean;
  frame: AxRect;
  role_description: string;
  type: string;
  children: RawAxeNode[];
}

function chooseScreenFrame(roots: RawAxeNode[]) {
  return roots[0]?.frame ?? {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };
}

function sameRect(a: AxRect, b: AxRect) {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

function normalizeAxTree(roots: RawAxeNode[]): AxSnapshot {
  const screen = chooseScreenFrame(roots);
  const elements: AxElement[] = [];

  const visit = (node: RawAxeNode, path: string) => {
    if (elements.length >= MAX_ELEMENTS) return;

    const frame = node.frame;
    const isScreenSized = sameRect(frame, screen);

    if (!isScreenSized) {
      elements.push({
        id: node.AXUniqueId ?? path,
        path,
        label: node.AXLabel ?? "",
        value: node.AXValue ?? "",
        role: node.role_description,
        type: node.type,
        enabled: node.enabled !== false,
        frame,
      });
    }

    for (let index = 0; index < node.children.length && elements.length < MAX_ELEMENTS; index++) {
      visit(node.children[index]!, `${path}.${index}`);
    }
  };

  for (let index = 0; index < roots.length && elements.length < MAX_ELEMENTS; index++) {
    visit(roots[index]!, String(index));
  }

  return {
    screen: {
      width: screen.width,
      height: screen.height,
    },
    elements,
  };
}

async function snapshotFromNative(udid: string): Promise<AxSnapshot> {
  let raw: RawAxeNode[];
  try {
    raw = JSON.parse(await axDescribeAsync(udid)) as RawAxeNode[];
  } catch {
    // The in-process AX bridge throws when the simulator can't satisfy
    // accessibility right now (framework missing, SpringBoard restarting,
    // etc). Surface as the standard "unavailable" error so the streamer backs
    // off and recovers automatically.
    return {
      screen: { width: 1, height: 1 },
      elements: [],
      errors: [AX_UNAVAILABLE_ERROR],
    };
  }
  return normalizeAxTree(raw);
}

function isAxUnavailableSnapshot(snapshot: AxSnapshot | null) {
  return snapshot?.errors?.includes(AX_UNAVAILABLE_ERROR) ?? false;
}

function isUsableAxSnapshot(snapshot: AxSnapshot) {
  return (
    snapshot.elements.length > 0 &&
    snapshot.screen.width > 1 &&
    snapshot.screen.height > 1
  );
}

async function collectAxSnapshot(udid: string): Promise<AxSnapshot> {
  const errors: string[] = [];

  try {
    const snapshot = await snapshotFromNative(udid);
    if (snapshot.errors?.length) return snapshot;
    if (!isUsableAxSnapshot(snapshot)) {
      throw new Error(
        `native AX returned ${snapshot.elements.length} elements in ${snapshot.screen.width}x${snapshot.screen.height} AX space`,
      );
    }
    return {
      ...snapshot,
      errors,
    };
  } catch (error) {
    errors.push((error as Error).message || String(error));
  }

  return {
    screen: { width: 1, height: 1 },
    elements: [],
    errors,
  };
}

function sseMessage(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

interface AxStreamer {
  addClient(res: { write(chunk: string): void }): () => void;
  dispose(): void;
}

function createAxStreamer({ udid }: { udid: string }): AxStreamer {
  const clients = new Set<{ write(chunk: string): void }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestMessage: string | null = null;
  let pollIntervalMs = POLL_INTERVAL_MS;
  let polling = false;
  let disposed = false;

  const schedule = () => {
    if (disposed || clients.size === 0 || timer) return;
    timer = setTimeout(poll, pollIntervalMs);
  };

  const poll = async () => {
    timer = null;
    if (disposed || polling || clients.size === 0) {
      schedule();
      return;
    }

    polling = true;
    try {
      const next = await collectAxSnapshot(udid);
      const nextMessage = sseMessage(next);
      if (nextMessage !== latestMessage) {
        for (const client of clients) client.write(nextMessage);
        pollIntervalMs = POLL_INTERVAL_MS;
      } else {
        pollIntervalMs = Math.min(pollIntervalMs * 2, MAX_POLL_INTERVAL_MS);
      }
      latestMessage = nextMessage;
      // If the helper says AX is unavailable (framework missing, sim
      // booting), keep polling but back off so we recover automatically
      // without spamming requests.
      if (isAxUnavailableSnapshot(next)) {
        pollIntervalMs = UNAVAILABLE_RETRY_INTERVAL_MS;
      }
    } finally {
      polling = false;
      schedule();
    }
  };

  return {
    addClient(res) {
      if (disposed) return () => {};
      clients.add(res);
      if (latestMessage) res.write(latestMessage);
      void poll();
      return () => {
        clients.delete(res);
        if (clients.size === 0 && timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      clients.clear();
      latestMessage = null;
    },
  };
}

export interface AxStreamerCache {
  get(udid: string): AxStreamer;
  prune(activeUdids: Iterable<string>): void;
  size(): number;
}

export function createAxStreamerCache(): AxStreamerCache {
  const streamers = new Map<string, AxStreamer>();

  return {
    /**
     * Get (or create) the accessibility-snapshot streamer for a simulator.
     * Snapshots come from the in-process native AX bridge keyed by udid.
     */
    get(udid: string) {
      const existing = streamers.get(udid);
      if (existing) return existing;

      const streamer = createAxStreamer({ udid });
      streamers.set(udid, streamer);
      return streamer;
    },
    /**
     * Drop streamers for simulators no longer present in `activeUdids`.
     * Without this, the cache grew append-only across a server's lifetime
     * as devices were booted/erased/reset, each entry holding a poll
     * timer, last-snapshot buffer, and SSE client set.
     */
    prune(activeUdids) {
      const active = activeUdids instanceof Set ? activeUdids : new Set(activeUdids);
      for (const [udid, streamer] of streamers) {
        if (!active.has(udid)) {
          streamer.dispose();
          streamers.delete(udid);
        }
      }
    },
    size() {
      return streamers.size;
    },
  };
}
