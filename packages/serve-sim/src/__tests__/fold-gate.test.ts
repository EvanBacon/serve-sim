import { describe, expect, test } from "bun:test";
import { FoldGate } from "../fold-gate";

function fakeTimers() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  return {
    setTimer: (fn: () => void, ms: number) => { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimer: (t: unknown) => { timers.delete(t as number); },
    advance(ms: number) {
      now += ms;
      for (const [k, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(k)) { timers.delete(k); t.fn(); }
      }
    },
  };
}

describe("FoldGate", () => {
  test("idle gate never holds", () => {
    expect(new FoldGate().whenSettled()).toBeNull();
  });

  test("a pose fold settles on the guest's postflight", async () => {
    const t = fakeTimers();
    const g = new FoldGate(t);
    g.begin("pose");
    const settled = g.whenSettled()!;
    t.advance(100);
    g.overlay("start");
    t.advance(1000); // past noOverlayMs, but the overlay was seen
    g.overlay("reset"); // mid-transition reset (after "cloak reveal began") does not end it
    expect(g.active).toBe(true);
    g.overlay("postflight");
    expect(g.active).toBe(true); // the app stays suppressed until the final reset
    g.overlay("reset");
    t.advance(349);
    expect(g.active).toBe(true); // the app's scene is still being re-hosted
    t.advance(1);
    expect(await settled).toBe("settled");
    expect(g.active).toBe(false);
  });

  test("a pose without an overlay (same panel) releases after noOverlayMs", async () => {
    const t = fakeTimers();
    const g = new FoldGate(t);
    g.begin("pose");
    const settled = g.whenSettled()!;
    t.advance(899);
    expect(g.active).toBe(true);
    t.advance(1);
    expect(await settled).toBe("no-overlay");
  });

  test("a guest-initiated fold (overlay start) holds until postflight or the cap", async () => {
    const t = fakeTimers();
    const g = new FoldGate(t);
    g.overlay("start");
    const settled = g.whenSettled()!;
    t.advance(2499);
    expect(g.active).toBe(true);
    t.advance(1);
    expect(await settled).toBe("timeout");
  });

  test("a stray postflight while idle does nothing", () => {
    const g = new FoldGate(fakeTimers());
    g.overlay("postflight");
    g.overlay("reset");
    expect(g.active).toBe(false);
  });

  test("postflight without a following reset settles after postflightMs", async () => {
    const t = fakeTimers();
    const g = new FoldGate({ ...t, postflightMs: 250, graceMs: 350 });
    g.overlay("start");
    const settled = g.whenSettled()!;
    g.overlay("postflight");
    t.advance(599);
    expect(g.active).toBe(true);
    t.advance(1);
    expect(await settled).toBe("settled");
  });

  test("a second pose mid-fold extends the hold", async () => {
    const t = fakeTimers();
    const g = new FoldGate(t);
    g.begin("pose");
    g.overlay("start");
    t.advance(2000);
    g.begin("pose");
    t.advance(800);
    expect(g.active).toBe(true); // the max restarted; the new pose's overlay hasn't shown yet
    g.overlay("start");
    g.overlay("postflight");
    g.overlay("reset");
    t.advance(350);
    expect(g.active).toBe(false);
  });
});
