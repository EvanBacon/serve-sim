import { isModifierUsage } from "./keyboard-modifiers";

export type KeyType = "down" | "up";

export interface KeySink {
  key(type: KeyType, usage: number): Promise<void>;
  close(): Promise<void>;
}

function withTimeout(operation: Promise<void>, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    operation.then(
      () => { clearTimeout(timer); resolve(); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Keeps a native keyboard's asynchronous down/up calls in submission order. */
export class KeySequencer {
  private queue: Promise<void> = Promise.resolve();
  private readonly heldModifiers = new Set<number>();
  private closing = false;
  private discardQueued = false;
  private closeAttempt: Promise<void> | undefined;

  constructor(private readonly sink: KeySink, private readonly timeoutMs = 250) {}

  key(type: KeyType, usage: number): Promise<void> {
    if (this.closing) return Promise.resolve();
    const pending = this.queue.then(async () => {
      if (this.discardQueued) return;
      const modifier = isModifierUsage(usage);
      // Rejection can happen after posting a down. Retain cleanup ownership
      // until a release actually succeeds, including after a rejected call.
      if (modifier && type === "down") this.heldModifiers.add(usage);
      try {
        await this.sink.key(type, usage);
        if (modifier && type === "up") this.heldModifiers.delete(usage);
      } finally {
        // An in-flight down can settle after the bounded close gave up waiting.
        // Release it again rather than letting that late completion latch it.
        if (this.discardQueued && modifier && type === "down") {
          this.heldModifiers.add(usage);
          await this.releaseModifier(usage);
        }
      }
    });
    this.queue = pending.catch(() => {});
    return pending;
  }

  drainAndRelease(): Promise<void> {
    if (this.closeAttempt) return this.closeAttempt;
    this.closing = true;
    const attempt = this.finishClose();
    this.closeAttempt = attempt;
    // Retain failed-release state so an explicit later close can retry it.
    void attempt.catch(() => {
      if (this.closeAttempt === attempt) this.closeAttempt = undefined;
    });
    return attempt;
  }

  private async releaseModifier(usage: number): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await withTimeout(
          Promise.resolve().then(() => this.sink.key("up", usage)),
          this.timeoutMs, "Modifier release",
        );
        this.heldModifiers.delete(usage);
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }

  private async finishClose(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await withTimeout(this.queue, this.timeoutMs, "Keyboard drain");
    } catch (error) {
      this.discardQueued = true;
      failures.push(error);
    }
    // Releases commute; bound the batch rather than spending a timeout on each
    // modifier in series. Failed releases remain tracked for a later retry.
    const releases = await Promise.allSettled(
      [...this.heldModifiers].map((usage) => this.releaseModifier(usage)),
    );
    for (const result of releases) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    try {
      await withTimeout(
        Promise.resolve().then(() => this.sink.close()), this.timeoutMs, "Native keyboard close",
      );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Keyboard teardown incomplete");
  }
}
