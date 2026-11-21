import { describe, expect, test } from "bun:test";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";
import { deviceHubInputShadowedMessage } from "../device-hub-input";
import { FoldGate } from "../fold-gate";
import { cliInputOrientation } from "../touch-remap";

type Hid = DeviceSessionDependencies["hid"];
const ACK = 0x84;
const settle = () => new Promise((r) => setTimeout(r, 10));

/** A started foldable session with a fake guest digitizer. */
async function duo(opts: { shadowed?: boolean; guest?: (display: string, type: string) => boolean; foldGate?: FoldGate; size?: { width: number; height: number } | null; noState?: boolean; duoStateWaitMs?: number } = {}) {
  const calls: unknown[][] = [];
  const hid: Hid = {
    touch: async (...a) => { calls.push(["legacy", ...a]); return true; },
    multiTouch: async (...a) => { calls.push(["legacyMulti", ...a]); return true; },
    guestTouch: async (display, type, x, y, edge) => { calls.push(edge ? ["guest", display, type, x, y, edge] : ["guest", display, type, x, y]); return opts.guest ? opts.guest(display, type) : true; },
    guestMultiTouch: async (display, type) => { calls.push(["guestMulti", display, type]); return true; },
    warmGuestHelper: async () => { calls.push(["warm"]); return true; },
    isFoldable: async () => true,
    button: async () => true, buttonHid: async () => true, key: async () => {}, scroll: async () => {},
    digitalCrown: async () => {}, orientation: async () => false, memoryWarning: async () => {},
    softwareKeyboard: async () => {}, caDebug: async () => false, hardwareKeyboard: async () => false,
    pose: async () => false, hinge: async () => false,
  };
  let onDuoState!: (state: { hingeDegrees?: number; primaryPanel?: "cover" | "inner"; orientations: object }) => void;
  const s = new DeviceSession("DUO", {
    capture: {
      start: async () => {}, stop: async () => {},
      subscribeMjpeg: async () => () => {}, subscribeAvcc: async () => () => {},
      subscribeSize: async (cb: (size: { width: number; height: number }) => void) => { if (opts.size !== null) cb(opts.size ?? { width: 1398, height: 2034 }); return () => {}; },
      snapshotJpeg: async () => null, setPreferredScreenSize: async () => {},
    } as never,
    hid,
    readDeviceHubInputShadowed: async () => opts.shadowed ?? false,
    watchDeviceHubInput: null,
    ...(opts.foldGate ? { foldGate: opts.foldGate } : {}),
    ...(opts.duoStateWaitMs != null ? { duoStateWaitMs: opts.duoStateWaitMs } : {}),
    createDuoMonitor: (_udid, onState) => { onDuoState = onState as never; return { close() {}, refreshOrientation() {} }; },
  });
  await s.start();
  // A started Duo normally has its hinge reading within a second.
  if (!opts.noState) onDuoState({ hingeDegrees: 0, orientations: {} });
  const replies: Record<string, unknown>[] = [];
  let receive!: (data: Buffer) => void;
  s.attachHidSocket({
    send(frame: Buffer) { if (frame[0] === ACK) replies.push(JSON.parse(frame.subarray(1).toString())); },
    close() {},
    on(event: string, cb: (data: Buffer) => void) { if (event === "message") receive = cb; },
  } as never);
  const send = (tag: number, payload: unknown) => receive(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
  return { s, calls, replies, send, duoState: (st: Parameters<typeof onDuoState>[0]) => onDuoState(st) };
}

describe("Duo guest-digitizer touch routing", () => {
  test("warms the guest helper when the session starts", async () => {
    const d = await duo();
    expect(d.calls).toContainEqual(["warm"]);
  });

  test("touches go to the guest digitizer of the active panel, even while Device Hub shadows legacy input", async () => {
    const d = await duo({ shadowed: true });
    d.send(0x03, { type: "begin", x: 0.3, y: 0.4, ack: 1 });
    d.send(0x03, { type: "end", x: 0.3, y: 0.4, ack: 2 });
    await settle();
    d.duoState({ hingeDegrees: 180, primaryPanel: "inner", orientations: {} });
    await settle();
    d.send(0x03, { type: "begin", x: 0.6, y: 0.2, ack: 3 });
    await settle();
    expect(d.calls.filter((c) => c[0] === "guest")).toEqual([
      ["guest", "primary", "begin", 0.3, 0.4],
      ["guest", "primary", "end", 0.3, 0.4],
      ["guest", "primary-1", "begin", 0.6, 0.2],
    ]);
    expect(d.calls.some((c) => c[0] === "legacy")).toBe(false);
    expect(d.replies.map((r) => r.ok)).toEqual([true, true, true]);
  });

  test("a home-edge swipe goes through the guest digitizer with its edge, shadowed or not", async () => {
    for (const shadowed of [false, true]) {
      const d = await duo({ shadowed });
      d.send(0x03, { type: "begin", x: 0.5, y: 0.99, edge: 3, ack: 1 });
      d.send(0x03, { type: "move", x: 0.5, y: 0.8, edge: 3, ack: 2 });
      d.send(0x03, { type: "end", x: 0.5, y: 0.6, edge: 3, ack: 3 });
      await settle();
      expect(d.calls.filter((c) => c[0] === "legacy" || c[0] === "guest")).toEqual([
        ["guest", "primary", "begin", 0.5, 0.99, 3],
        ["guest", "primary", "move", 0.5, 0.8, 3],
        ["guest", "primary", "end", 0.5, 0.6, 3],
      ]);
      expect(d.replies.map((r) => r.ok)).toEqual([true, true, true]);
    }
  });

  test("a failed guest begin falls back to legacy for the whole gesture; a later failure never switches", async () => {
    const d = await duo({ guest: (_display, type) => type !== "begin" });
    d.send(0x03, { type: "begin", x: 0.1, y: 0.1, ack: 1 });
    await settle();
    d.send(0x03, { type: "move", x: 0.2, y: 0.2, ack: 2 });
    d.send(0x03, { type: "end", x: 0.2, y: 0.2, ack: 3 });
    await settle();
    expect(d.calls.filter((c) => c[0] === "legacy" || c[0] === "guest").map((c) => [c[0], c[0] === "guest" ? c[2] : c[1]])).toEqual([
      ["guest", "begin"], ["legacy", "begin"], ["legacy", "move"], ["legacy", "end"],
    ]);
    const mid = await duo({ guest: (_display, type) => type !== "move" });
    mid.send(0x03, { type: "begin", x: 0.1, y: 0.1, ack: 1 });
    await settle();
    mid.send(0x03, { type: "move", x: 0.2, y: 0.2, ack: 2 });
    await settle();
    expect(mid.replies.map((r) => r.ok)).toEqual([true, false]);
    expect(mid.calls.some((c) => c[0] === "legacy")).toBe(false);
  });

  test("a failed guest begin while shadowed is refused, not sent through legacy", async () => {
    const d = await duo({ shadowed: true, guest: () => false });
    d.send(0x03, { type: "begin", x: 0.1, y: 0.1, ack: 1 });
    await settle();
    expect(d.replies).toEqual([{ ack: 1, ok: false, error: deviceHubInputShadowedMessage("DUO") }]);
    expect(d.calls.some((c) => c[0] === "legacy")).toBe(false);
  });

  test("two-finger touches use the guest digitizer too", async () => {
    const d = await duo({ shadowed: true });
    d.send(0x05, { type: "begin", x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 });
    d.send(0x05, { type: "end", x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 });
    await settle();
    expect(d.calls.filter((c) => c[0] === "guestMulti")).toEqual([["guestMulti", "primary", "begin"], ["guestMulti", "primary", "end"]]);
    expect(d.calls.some((c) => c[0] === "legacyMulti")).toBe(false);
  });

  test("a touch that begins during a fold waits for the overlay, then goes to the panel it was aimed at", async () => {
    const gate = new FoldGate({ noOverlayMs: 10_000, maxMs: 10_000, graceMs: 0 });
    const d = await duo({ foldGate: gate });
    d.duoState({ hingeDegrees: 180, primaryPanel: "inner", orientations: {} });
    await settle();
    gate.overlay("start");
    d.send(0x03, { type: "begin", x: 0.4, y: 0.4, ack: 1 });
    d.send(0x03, { type: "end", x: 0.4, y: 0.4, ack: 2 });
    await settle();
    expect(d.calls.filter((c) => c[0] === "guest")).toEqual([]);
    expect(d.replies).toEqual([]);
    gate.overlay("postflight");
    gate.overlay("reset");
    await settle();
    expect(d.calls.filter((c) => c[0] === "guest")).toEqual([["guest", "primary-1", "begin", 0.4, 0.4], ["guest", "primary-1", "end", 0.4, 0.4]]);
    expect(d.replies.map((r) => r.ok)).toEqual([true, true]);
  });

  test("a viewer touch aimed at a panel the fold switched away from is refused, never redirected", async () => {
    const gate = new FoldGate({ noOverlayMs: 10_000, maxMs: 10_000, graceMs: 0 });
    const d = await duo({ foldGate: gate });
    gate.overlay("start");
    d.send(0x03, { type: "begin", x: 0.4, y: 0.4, panel: "cover", ack: 1 });
    d.send(0x03, { type: "move", x: 0.5, y: 0.5, ack: 2 });
    d.send(0x03, { type: "end", x: 0.5, y: 0.5, ack: 3 });
    await settle();
    d.duoState({ hingeDegrees: 180, primaryPanel: "inner", orientations: {} });
    gate.overlay("postflight");
    gate.overlay("reset");
    await settle();
    expect(d.calls.some((c) => c[0] === "guest" || c[0] === "legacy")).toBe(false);
    expect(d.replies[0]).toEqual({ ack: 1, ok: false, error: "Fold in progress: the touch was aimed at the cover display, but the inner display is active now. Retry the touch." });
    expect(d.replies.slice(1).map((r) => r.ok)).toEqual([false, false]);
    // The next gesture is delivered normally.
    d.send(0x03, { type: "begin", x: 0.1, y: 0.1, ack: 4 });
    await settle();
    expect(d.calls.filter((c) => c[0] === "guest")).toEqual([["guest", "primary-1", "begin", 0.1, 0.1]]);
  });

  test("a touch without a panel (CLI) during a fold goes to the fold's target panel", async () => {
    const gate = new FoldGate({ noOverlayMs: 10_000, maxMs: 10_000, graceMs: 0 });
    const d = await duo({ foldGate: gate });
    gate.begin("hinge", "inner"); // `serve-sim fold 180` from the cover
    d.send(0x03, { type: "begin", x: 0.4, y: 0.4, ack: 1 });
    await settle();
    d.duoState({ hingeDegrees: 180, primaryPanel: "inner", orientations: {} });
    gate.overlay("start");
    gate.overlay("postflight");
    gate.overlay("reset");
    await settle();
    expect(d.calls.filter((c) => c[0] === "guest")).toEqual([["guest", "primary-1", "begin", 0.4, 0.4]]);
    expect(d.replies.map((r) => r.ok)).toEqual([true]);
  });

  test("before any Duo state, touches follow the captured panel instead of defaulting to the cover", async () => {
    const d = await duo({ size: { width: 2007, height: 2853 }, noState: true, duoStateWaitMs: 0 });
    d.send(0x03, { type: "begin", x: 0.3, y: 0.3, ack: 1 });
    await settle();
    expect(d.calls.filter((c) => c[0] === "guest")).toEqual([["guest", "primary-1", "begin", 0.3, 0.3]]);
    expect(d.s.screenConfig().duoPanel).toBe("inner");
  });

  test("legacy touches carry the touch panel's size, even before the first frame and after a fold", async () => {
    const d = await duo({ size: null, noState: true, duoStateWaitMs: 0, guest: () => false });
    d.send(0x03, { type: "begin", x: 0.5, y: 0.99, edge: 3, ack: 1 });
    d.send(0x03, { type: "end", x: 0.5, y: 0.8, edge: 3, ack: 2 });
    await settle();
    d.duoState({ hingeDegrees: 180, primaryPanel: "inner", orientations: {} });
    await settle();
    d.send(0x03, { type: "begin", x: 0.5, y: 0.99, edge: 3, ack: 3 });
    await settle();
    // The legacy Indigo target is chosen from this size natively.
    expect(d.calls.filter((c) => c[0] === "legacy").map((c) => [c[1], c[4], c[5]])).toEqual([
      ["begin", 1398, 2034], ["end", 1398, 2034], ["begin", 2007, 2853],
    ]);
  });

  test("/config gives the CLI the server's panel and its orientation, so its remap matches", async () => {
    const d = await duo();
    d.duoState({ hingeDegrees: 180, primaryPanel: "inner", orientations: { inner: "landscape_left", cover: "portrait" } });
    await settle();
    const config = d.s.screenConfig();
    expect(config.duoPanel).toBe("inner");
    expect(config.orientation).toBe("landscape_left");
    // Raw size still reports the captured framebuffer; the remap only needs it to be portrait-shaped.
    expect(cliInputOrientation({ ...config, width: 2007, height: 2853 }, { includeFoldables: true })).toBe("landscape_left");
  });

  test("the first touch right after start waits for the Duo panel readback instead of guessing the cover", async () => {
    const d = await duo({ noState: true, duoStateWaitMs: 5_000 });
    d.send(0x03, { type: "begin", x: 0.2, y: 0.2, ack: 1 });
    await settle();
    expect(d.calls.filter((c) => c[0] === "guest")).toEqual([]);
    d.duoState({ primaryPanel: "inner", orientations: {} });
    await settle();
    expect(d.calls.filter((c) => c[0] === "guest")).toEqual([["guest", "primary-1", "begin", 0.2, 0.2]]);
  });
});
