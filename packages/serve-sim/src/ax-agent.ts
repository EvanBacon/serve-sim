/**
 * Per-device agent session over the accessibility tree: snapshot with refs,
 * act on a ref (tap / long-press at the element's center), and wait for the
 * screen to settle, returning what changed.
 *
 * One AxAgent lives on each DeviceSession, so its ref state is bounded by the
 * device's current tree (see ax-refs.ts) and dies with the session. The
 * simulator is reached only through injected deps, so the logic is tested
 * without one. Operations are serialized: an act's tap, settle and ref update
 * never interleave with another request's.
 */
import type { AxSnapshot } from "./ax-shared";
import {
  RESNAPSHOT_HINT,
  agentSnapshot,
  assignRefs,
  diffSnapshots,
  isVisibleFrame,
  resolveRef,
  type AgentDiff,
  type AgentSnapshot,
  type RefEntry,
  type RefState,
} from "./ax-refs";
import { clampSettleTimeout, waitForSettle, type SettleResult } from "./ax-settle";
import { debugAx } from "./debug";

export interface AxAgentDeps {
  /** One normalized snapshot (failures reported in `errors`, as collectAxSnapshot does). */
  collect(): Promise<AxSnapshot>;
  /** Monotonic count of captured frames whose content changed, or null when unknown. */
  contentFrames(): Promise<number | null>;
  /** Touch down at normalized (0..1) display coords, hold `holdMs`, release. */
  tap(point: { x: number; y: number }, holdMs: number): Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class AxAgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AxAgentError";
  }

  toJSON() {
    return { error: this.code, message: this.message };
  }
}

export type SettleReport = Omit<SettleResult<unknown>, "last" | "lastFrames">;

export interface ActResult {
  ok: true;
  action: "tap" | "longpress";
  ref: string;
  target: { role: string; label?: string; center: { x: number; y: number } };
  settle: SettleReport | null;
  diff: AgentDiff | null;
}

const TAP_HOLD_MS = 40;
const LONG_PRESS_HOLD_MS = 800;

const REF_ERROR_STATUS: Record<string, number> = {
  invalid_ref: 400,
  no_snapshot: 409,
  unknown_ref: 404,
  stale_ref: 409,
};

/**
 * Canonical tree signature. Built field by field: the native bridge emits
 * frame keys in a different order on every read, so serializing the
 * elements as-is never compares equal for an unchanged screen.
 */
function signature(snapshot: AxSnapshot): string {
  return JSON.stringify(snapshot.elements.map((e) => [
    e.id, e.path, e.label, e.value, e.role, e.type, e.enabled,
    e.frame.x, e.frame.y, e.frame.width, e.frame.height,
  ]));
}

function report(result: SettleResult<unknown>): SettleReport {
  const { last: _last, lastFrames: _lastFrames, ...rest } = result;
  return rest;
}

/** Normalized tap point: the center of the element's onscreen part. */
function tapPoint(entry: RefEntry, screen: { width: number; height: number }) {
  const r = entry.rect;
  const left = Math.max(0, r.x);
  const top = Math.max(0, r.y);
  const right = Math.min(screen.width, r.x + r.width);
  const bottom = Math.min(screen.height, r.y + r.height);
  return { x: (left + right) / 2 / screen.width, y: (top + bottom) / 2 / screen.height };
}

function describeEntry(entry: RefEntry): string {
  return [entry.node.role, entry.node.label ? `"${entry.node.label}"` : ""].filter(Boolean).join(" ") || "unlabelled element";
}

export class AxAgent {
  private state: RefState | null = null;
  /**
   * Content-frame count the session snapshot is known to match (null when
   * unknown). While the live counter still equals it, nothing on screen has
   * changed, so `act` can tap from the snapshot without another ~200 ms read.
   */
  private stateFrames: number | null = null;
  private all = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: AxAgentDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async fresh(): Promise<AxSnapshot> {
    const snapshot = await this.deps.collect();
    if (snapshot.errors?.length) {
      throw new AxAgentError(503, "ax_unavailable", snapshot.errors.join("; "));
    }
    return snapshot;
  }

  private frames(): Promise<number | null> {
    return this.deps.contentFrames().catch(() => null);
  }

  /** A fresh read plus the frame count it matches (null if frames moved during it). */
  private async freshWithFrames(): Promise<{ snapshot: AxSnapshot; frames: number | null }> {
    const before = await this.frames();
    const snapshot = await this.fresh();
    const after = before == null ? null : await this.frames();
    return { snapshot, frames: before != null && before === after ? before : null };
  }

  private settleUntilQuiet(timeoutMs: number) {
    return waitForSettle<AxSnapshot>({
      now: this.now,
      sleep: this.sleep,
      timeoutMs,
      frames: () => this.deps.contentFrames(),
      ...(debugAx.enabled ? { trace: (event: string, at: number, detail?: Record<string, unknown>) => debugAx("settle +%dms %s %o", at, event, detail ?? {}) } : {}),
      read: async () => {
        const snapshot = await this.fresh();
        return { signature: signature(snapshot), value: snapshot };
      },
    });
  }

  /** `GET /ax/snapshot`: refs for the current screen; becomes the session snapshot. */
  snapshot(opts: { all?: boolean } = {}): Promise<AgentSnapshot> {
    return this.serialize(async () => {
      const { snapshot, frames } = await this.freshWithFrames();
      this.all = opts.all === true;
      this.state = assignRefs(this.state, snapshot, { all: this.all });
      this.stateFrames = frames;
      return agentSnapshot(this.state, { all: this.all });
    });
  }

  /** `POST /ax/act`: tap a ref from the last snapshot, optionally waiting for the screen to settle. */
  act(body: unknown): Promise<ActResult> {
    return this.serialize(async () => {
      if (!body || typeof body !== "object") {
        throw new AxAgentError(400, "invalid_request", 'Expected a JSON body like {"ref":"@e2"}.');
      }
      const request = body as { ref?: unknown; action?: unknown; settle?: unknown; timeoutMs?: unknown };
      if (typeof request.ref !== "string") {
        throw new AxAgentError(400, "invalid_request", 'Missing "ref" (e.g. "@e2").');
      }
      const action = request.action ?? "tap";
      if (action !== "tap" && action !== "longpress") {
        throw new AxAgentError(400, "invalid_request", `Unsupported action "${String(action)}" (expected tap or longpress).`);
      }
      const timeoutMs = clampSettleTimeout(request.timeoutMs);
      if (timeoutMs == null) throw new AxAgentError(400, "invalid_request", '"timeoutMs" must be a number of milliseconds.');

      const lookup = resolveRef(this.state, request.ref);
      if (!lookup.ok) throw new AxAgentError(REF_ERROR_STATUS[lookup.code] ?? 409, lookup.code, lookup.message);

      // Re-resolve against the live tree: tap where the element is now, or
      // refuse if it is gone. Never tap a guess. An unchanged frame counter
      // proves the screen is the snapshot's, so that read can be skipped.
      const live = this.stateFrames != null && (await this.frames()) === this.stateFrames;
      const before = live && this.state ? this.state : assignRefs(this.state, await this.fresh(), { all: this.all });
      const entry = before.entries.get(lookup.entry.ref);
      if (!entry) {
        throw new AxAgentError(
          409,
          "stale_ref",
          `${lookup.entry.ref} is stale: the element it named (${describeEntry(lookup.entry)}) is no longer on screen. ${RESNAPSHOT_HINT}`,
        );
      }
      if (!isVisibleFrame(entry.rect, before.screen)) {
        throw new AxAgentError(
          409,
          "offscreen",
          `${entry.ref} (${describeEntry(entry)}) is offscreen; scroll it into view first. ${RESNAPSHOT_HINT}`,
        );
      }

      await this.deps.tap(tapPoint(entry, before.screen), action === "longpress" ? LONG_PRESS_HOLD_MS : TAP_HOLD_MS);

      const target = {
        role: entry.node.role,
        ...(entry.node.label ? { label: entry.node.label } : {}),
        center: entry.node.center,
      };
      // The tap changes the screen (or may), so the snapshot is no longer proven current.
      this.stateFrames = null;
      if (request.settle !== true) {
        this.state = before;
        return { ok: true, action, ref: entry.ref, target, settle: null, diff: null };
      }

      const settled = await this.settleUntilQuiet(timeoutMs);
      const latest = settled.last ?? null;
      const after = latest ? assignRefs(before, latest, { all: this.all }) : before;
      this.state = after;
      this.stateFrames = latest ? (settled.lastFrames ?? null) : null;
      return {
        ok: true,
        action,
        ref: entry.ref,
        target,
        settle: report(settled),
        diff: latest ? diffSnapshots(before, after, { all: this.all }) : null,
      };
    });
  }

  /** `GET /ax/settle`: wait for quiet, then diff against the last snapshot the agent saw. */
  settle(opts: { timeoutMs?: unknown } = {}): Promise<{ settle: SettleReport; diff: AgentDiff }> {
    return this.serialize(async () => {
      const timeoutMs = clampSettleTimeout(opts.timeoutMs);
      if (timeoutMs == null) throw new AxAgentError(400, "invalid_request", '"timeoutMs" must be a number of milliseconds.');
      const settled = await this.settleUntilQuiet(timeoutMs);
      const latest = settled.last ?? null;
      if (!latest) {
        throw new AxAgentError(503, "ax_unavailable", settled.lastError ?? "Accessibility unavailable on this simulator.");
      }
      const before = this.state;
      const after = assignRefs(before, latest, { all: this.all });
      this.state = after;
      this.stateFrames = settled.lastFrames ?? null;
      return { settle: report(settled), diff: diffSnapshots(before, after, { all: this.all }) };
    });
  }
}
