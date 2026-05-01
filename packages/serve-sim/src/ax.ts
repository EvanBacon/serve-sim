import { execFile } from "child_process";
import { promisify } from "util";
import { AXE_NOT_INSTALLED_ERROR } from "./ax-shared";
import type { AxElement, AxRect, AxSnapshot } from "./ax-shared";

export type { AxElement, AxRect, AxSnapshot } from "./ax-shared";

const SNAPSHOT_TIMEOUT_MS = 3500;
const MAX_ELEMENTS = 500;
const POLL_INTERVAL_MS = 500;
const execFileAsync = promisify(execFile);

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

async function execFileText(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    timeout: SNAPSHOT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.toString();
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

  const visit = (node: RawAxeNode, path: number[]) => {
    const frame = node.frame;
    const isScreenSized = sameRect(frame, screen);

    if (!isScreenSized && elements.length < MAX_ELEMENTS) {
      elements.push({
        id: node.AXUniqueId ?? path.join("."),
        path: path.join("."),
        label: node.AXLabel ?? "",
        value: node.AXValue ?? "",
        role: node.role_description,
        type: node.type,
        enabled: node.enabled !== false,
        frame,
      });
    }

    node.children.forEach((child, index) => visit(child, [...path, index]));
  };

  roots.forEach((root, index) => visit(root, [index]));

  return {
    screen: {
      width: screen.width,
      height: screen.height,
    },
    elements,
  };
}

async function snapshotWithAxe(udid: string) {
  const output = await execFileText("axe", ["describe-ui", "--udid", udid]);
  return normalizeAxTree(JSON.parse(output) as RawAxeNode[]);
}

function isAxeNotInstalledError(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAxeUnavailableSnapshot(snapshot: AxSnapshot | null) {
  return snapshot?.errors?.includes(AXE_NOT_INSTALLED_ERROR) ?? false;
}

function isUsableAxSnapshot(snapshot: AxSnapshot) {
  return (
    snapshot.elements.length > 0 &&
    snapshot.screen.width > 1 &&
    snapshot.screen.height > 1
  );
}

async function collectAxSnapshot(udid: string) {
  const errors: string[] = [];

  try {
    const snapshot = await snapshotWithAxe(udid);
    if (!isUsableAxSnapshot(snapshot)) {
      throw new Error(
        `axe returned ${snapshot.elements.length} elements in ${snapshot.screen.width}x${snapshot.screen.height} AX space`,
      );
    }
    return {
      ...snapshot,
      errors,
    };
  } catch (error) {
    const err = error as Error & { stderr?: string };
    errors.push(
      isAxeNotInstalledError(error)
        ? AXE_NOT_INSTALLED_ERROR
        : err.stderr || err.message || String(error),
    );
  }

  return {
    screen: { width: 1, height: 1 },
    elements: [],
    errors,
  };
}

function writeSse(res: { write(chunk: string): void }, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createAxStreamer({
  udid,
}: {
  udid: string;
}) {
  const clients = new Set<{ write(chunk: string): void }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: AxSnapshot | null = null;
  let polling = false;
  let axeUnavailable = false;

  const schedule = () => {
    if (clients.size === 0 || timer || axeUnavailable) return;
    timer = setTimeout(poll, POLL_INTERVAL_MS);
  };

  const poll = async () => {
    timer = null;
    if (polling || clients.size === 0 || axeUnavailable) {
      schedule();
      return;
    }

    polling = true;
    try {
      latest = await collectAxSnapshot(udid);
      for (const client of clients) writeSse(client, latest);
      axeUnavailable = isAxeUnavailableSnapshot(latest);
    } finally {
      polling = false;
      schedule();
    }
  };

  return {
    addClient(res: { write(chunk: string): void }) {
      clients.add(res);
      if (latest) writeSse(res, latest);
      if (!axeUnavailable) void poll();
      return () => {
        clients.delete(res);
        if (clients.size === 0 && timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
}

export function createAxStreamerCache() {
  const streamers = new Map<string, ReturnType<typeof createAxStreamer>>();

  return {
    get(udid: string) {
      const existing = streamers.get(udid);
      if (existing) return existing;

      const streamer = createAxStreamer({ udid });
      streamers.set(udid, streamer);
      return streamer;
    },
  };
}
