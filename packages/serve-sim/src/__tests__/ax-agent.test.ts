import { describe, expect, test } from "bun:test";
import type { AxElement, AxSnapshot } from "../ax-shared";
import { AxAgent, AxAgentError, type AxAgentDeps } from "../ax-agent";

const SCREEN = { width: 400, height: 800 };

function el(label: string, y: number, overrides: Partial<AxElement> = {}): AxElement {
  const path = overrides.path ?? `0.${Math.round(y)}`;
  return {
    id: path,
    path,
    label,
    value: "",
    role: "cell",
    type: "Cell",
    enabled: true,
    frame: { x: 0, y, width: 400, height: 50 },
    ...overrides,
  };
}

const HOME: AxSnapshot = { screen: SCREEN, elements: [el("Settings", 50, { type: "Heading", role: "heading" }), el("General", 200), el("Privacy", 300)], errors: [] };
const GENERAL: AxSnapshot = { screen: SCREEN, elements: [el("Back", 50, { type: "Button", role: "button" }), el("About", 200), el("Software Update", 300)], errors: [] };

/** Fake device: `screens` is what each AX read returns (last one repeats); taps are recorded. */
function fakeDevice(screens: AxSnapshot[], opts: { onTap?: () => void; frames?: () => number | null } = {}) {
  let reads = 0;
  let t = 0;
  const taps: Array<{ x: number; y: number; holdMs: number }> = [];
  const deps: AxAgentDeps = {
    collect: async () => structuredClone(screens[Math.min(reads++, screens.length - 1)]!),
    contentFrames: async () => opts.frames?.() ?? null,
    tap: async (point, holdMs) => { taps.push({ ...point, holdMs }); opts.onTap?.(); },
    now: () => t,
    sleep: async (ms) => { t += ms; },
  };
  return { deps, taps, reads: () => reads };
}

async function expectAgentError(promise: Promise<unknown>, status: number, code: string): Promise<AxAgentError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AxAgentError);
    expect(error).toMatchObject({ status, code });
    return error as AxAgentError;
  }
  throw new Error(`expected ${code}`);
}

describe("AxAgent.snapshot", () => {
  test("returns compact nodes with refs and records them for later actions", async () => {
    const { deps } = fakeDevice([HOME]);
    const agent = new AxAgent(deps);
    const snap = await agent.snapshot();
    expect(snap.screen).toEqual(SCREEN);
    expect(snap.nodes.map((n) => `${n.ref} ${n.label}`)).toEqual(["@e1 Settings", "@e2 General", "@e3 Privacy"]);
  });

  test("fails with 503 when accessibility is unavailable", async () => {
    const { deps } = fakeDevice([{ screen: { width: 1, height: 1 }, elements: [], errors: ["Accessibility unavailable on this simulator."] }]);
    const error = await expectAgentError(new AxAgent(deps).snapshot(), 503, "ax_unavailable");
    expect(error.message).toContain("Accessibility unavailable");
  });
});

describe("AxAgent.act", () => {
  test("taps the element's center in normalized screen coords", async () => {
    const { deps, taps } = fakeDevice([HOME]);
    const agent = new AxAgent(deps);
    await agent.snapshot();
    const result = await agent.act({ ref: "@e2" });
    expect(taps).toEqual([{ x: 0.5, y: 225 / 800, holdMs: 40 }]);
    expect(result).toMatchObject({ ok: true, action: "tap", ref: "@e2", target: { label: "General", center: { x: 200, y: 225 } }, settle: null, diff: null });
  });

  test("longpress holds the touch", async () => {
    const { deps, taps } = fakeDevice([HOME]);
    const agent = new AxAgent(deps);
    await agent.snapshot();
    await agent.act({ ref: "e2", action: "longpress" });
    expect(taps[0]!.holdMs).toBeGreaterThanOrEqual(500);
  });

  test("with settle, waits for quiet and returns the diff to the new screen with usable refs", async () => {
    let tapped = false;
    const screens = [HOME];
    const device = fakeDevice(screens, { onTap: () => { tapped = true; } });
    const collect = device.deps.collect;
    device.deps.collect = async () => (tapped ? structuredClone(GENERAL) : collect());
    const agent = new AxAgent(device.deps);
    await agent.snapshot();
    const result = await agent.act({ ref: "@e2", settle: true, timeoutMs: 2000 });
    expect(result.settle).toMatchObject({ settled: true, reason: "quiet" });
    expect(result.diff!.removed.map((n) => n.label)).toEqual(["Settings", "General", "Privacy"]);
    expect(result.diff!.added.map((n) => `${n.ref} ${n.label}`)).toEqual(["@e4 Back", "@e5 About", "@e6 Software Update"]);
    // The settled screen is now the session snapshot: new refs resolve, old ones are stale.
    await agent.act({ ref: "@e5" });
    await expectAgentError(agent.act({ ref: "@e2" }), 409, "stale_ref");
  });

  test("an element that persists keeps its ref across act and is re-resolved at its new position", async () => {
    const moved: AxSnapshot = { ...HOME, elements: [el("Settings", 50, { type: "Heading", role: "heading" }), el("Banner", 100), el("General", 400), el("Privacy", 500)] };
    const { deps, taps } = fakeDevice([HOME, moved]);
    const agent = new AxAgent(deps);
    await agent.snapshot();
    await agent.act({ ref: "@e2" });
    expect(taps[0]!.y).toBeCloseTo(425 / 800);
  });

  test("never taps when the ref is unknown, stale, offscreen, or the element vanished", async () => {
    const { deps, taps } = fakeDevice([HOME, GENERAL]);
    const agent = new AxAgent(deps);
    await expectAgentError(agent.act({ ref: "@e1" }), 409, "no_snapshot");
    await agent.snapshot();
    await expectAgentError(agent.act({ ref: "@e42" }), 404, "unknown_ref");
    // Screen changed under the agent: @e2 (General) no longer exists.
    const vanished = await expectAgentError(agent.act({ ref: "@e2" }), 409, "stale_ref");
    expect(vanished.message).toContain("General");
    expect(vanished.message).toContain("serve-sim ax --refs");
    expect(taps).toEqual([]);
  });

  test("refuses to tap an element that scrolled offscreen", async () => {
    const scrolled: AxSnapshot = { ...HOME, elements: HOME.elements.map((e) => ({ ...e, frame: { ...e.frame, y: e.frame.y + 1000 } })) };
    const { deps, taps } = fakeDevice([HOME, scrolled]);
    const agent = new AxAgent(deps);
    await agent.snapshot();
    await expectAgentError(agent.act({ ref: "@e2" }), 409, "offscreen");
    expect(taps).toEqual([]);
  });

  test("taps the onscreen part of a partially visible element", async () => {
    const partial: AxSnapshot = { ...HOME, elements: [el("Tall", 700, { frame: { x: 0, y: 700, width: 400, height: 400 } })] };
    const { deps, taps } = fakeDevice([partial]);
    const agent = new AxAgent(deps);
    await agent.snapshot();
    await agent.act({ ref: "@e1" });
    expect(taps[0]!.y).toBeCloseTo(750 / 800);
  });

  test("validates the request body", async () => {
    const { deps } = fakeDevice([HOME]);
    const agent = new AxAgent(deps);
    await agent.snapshot();
    await expectAgentError(agent.act(null), 400, "invalid_request");
    await expectAgentError(agent.act({}), 400, "invalid_request");
    await expectAgentError(agent.act({ ref: "General" }), 400, "invalid_ref");
    await expectAgentError(agent.act({ ref: "@e1", action: "swipe" }), 400, "invalid_request");
    await expectAgentError(agent.act({ ref: "@e1", timeoutMs: "soon" }), 400, "invalid_request");
  });
});

describe("AxAgent.settle", () => {
  test("waits for quiet and diffs against the last snapshot the agent saw", async () => {
    const { deps } = fakeDevice([HOME, GENERAL]);
    const agent = new AxAgent(deps);
    await agent.snapshot();
    const result = await agent.settle({ timeoutMs: 1000 });
    expect(result.settle).toMatchObject({ settled: true });
    expect(result.diff.added.map((n) => n.label)).toEqual(["Back", "About", "Software Update"]);
    // The settled screen becomes the session snapshot.
    const again = await agent.settle({ timeoutMs: 1000 });
    expect(again.diff).toEqual({ added: [], removed: [], changed: [] });
  });

  test("uses the frame counter when available and reports a timeout when frames keep changing", async () => {
    let f = 0;
    const { deps } = fakeDevice([HOME], { frames: () => f++ });
    const result = await new AxAgent(deps).settle({ timeoutMs: 600 });
    expect(result.settle).toMatchObject({ settled: false, reason: "timeout", busy: ["frames"], signals: { frames: true } });
  });

  test("rejects a bad timeout", async () => {
    const { deps } = fakeDevice([HOME]);
    await expectAgentError(new AxAgent(deps).settle({ timeoutMs: "x" }), 400, "invalid_request");
  });
});

describe("AxAgent serialization", () => {
  test("concurrent operations run one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const { deps } = fakeDevice([HOME]);
    const collect = deps.collect;
    deps.collect = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return collect();
    };
    const agent = new AxAgent(deps);
    await Promise.all([agent.snapshot(), agent.snapshot(), agent.snapshot()]);
    expect(maxActive).toBe(1);
  });
});
