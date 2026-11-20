import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";

// Server shutdown (and registry eviction when a simulator goes away) ends in
// DeviceSession.close(). That is the only place the in-process native helpers
// are released: the HID client (which must release held modifier keys), the
// capture/encoder, the shared MJPEG + size subscriptions, the Duo state
// monitor (which owns the `simctl spawn … watch-angle` and `log` children),
// and every viewer/CLI HID socket. A leak here leaves helpers running in the
// guest across server restarts, so this pins exactly what close() releases,
// that one failing cleanup cannot skip the rest, and that close is one-shot.

type Hid = DeviceSessionDependencies["hid"];
type Capture = DeviceSessionDependencies["capture"];

const errorSpy = spyOn(console, "error");
afterEach(() => errorSpy.mockReset());
afterAll(() => errorSpy.mockRestore());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(opts: {
  foldable?: boolean | Promise<boolean>;
  hidClose?: () => Promise<void>;
  captureStop?: () => Promise<void>;
  readShadowed?: () => Promise<boolean | null>;
} = {}) {
  const events: string[] = [];
  const capture: Capture = {
    start: async () => { events.push("capture.start"); },
    stop: opts.captureStop ?? (async () => { events.push("capture.stop"); }),
    subscribeMjpeg: async () => {
      events.push("mjpeg.subscribe");
      return () => { events.push("mjpeg.unsubscribe"); };
    },
    subscribeAvcc: async () => () => {},
    subscribeSize: async (cb) => {
      void cb({ width: 1206, height: 2622 });
      events.push("size.subscribe");
      return () => { events.push("size.unsubscribe"); };
    },
    snapshotJpeg: async () => null,
    setPreferredScreenSize: async () => {},
  };
  const hid: Hid = {
    touch: async (type) => { events.push(`hid.touch:${type}`); return true; },
    multiTouch: async (type) => { events.push(`hid.multiTouch:${type}`); return true; },
    button: async (button) => { events.push(`hid.button:${button}`); return true; },
    buttonHid: async () => { events.push("hid.buttonHid"); return true; },
    key: async (type) => { events.push(`hid.key:${type}`); },
    scroll: async () => { events.push("hid.scroll"); },
    digitalCrown: async () => { events.push("hid.digitalCrown"); },
    orientation: async () => true,
    memoryWarning: async () => {},
    softwareKeyboard: async () => {},
    caDebug: async () => false,
    hardwareKeyboard: async () => false,
    pose: async () => true,
    hinge: async () => true,
    isFoldable: async () => opts.foldable ?? false,
    close: opts.hidClose ?? (async () => { events.push("hid.close"); }),
  };
  const monitors: string[] = [];
  const session = new DeviceSession("CLOSE-UDID", {
    capture,
    hid,
    readDeviceHubInputShadowed: opts.readShadowed ?? (async () => false),
    rollingBuffer: null,
    createDuoMonitor: (udid) => {
      monitors.push(udid);
      events.push("monitor.create");
      return { close() { events.push("monitor.close"); }, refreshOrientation() {} };
    },
  });
  let receive: ((data: Buffer) => void) | undefined;
  const attach = () =>
    session.attachHidSocket({
      send() {},
      close() { events.push("socket.close"); },
      on(event: string, cb: (data: Buffer) => void) { if (event === "message") receive = cb; },
    } as never);
  const send = (tag: number, payload: unknown) =>
    receive!(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
  return { session, events, monitors, attach, send };
}

const releaseEvents = (events: string[]) =>
  events.filter((e) => /close|stop|unsubscribe/.test(e));

describe("DeviceSession.close releases every native helper", () => {
  test("a running Duo session releases monitor, subscriptions, sockets, HID and capture once", async () => {
    const h = harness({ foldable: true });
    await h.session.start();
    h.attach();
    h.attach();
    expect(h.events).toContain("monitor.create");
    h.events.length = 0;

    h.session.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(releaseEvents(h.events).sort()).toEqual([
      "capture.stop",
      "hid.close",
      "mjpeg.unsubscribe",
      "monitor.close",
      "size.unsubscribe",
      "socket.close",
      "socket.close",
    ]);
    // HID close (modifier release) is ordered before capture teardown.
    expect(h.events.indexOf("hid.close")).toBeLessThan(h.events.indexOf("capture.stop"));

    h.events.length = 0;
    h.session.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.events).toEqual([]);
    await expect(h.session.start()).rejects.toThrow("CLOSE-UDID is closed");
  });

  test("a non-Duo session never spawns a monitor and still releases HID and capture", async () => {
    const h = harness({ foldable: false });
    await h.session.start();
    h.session.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.monitors).toEqual([]);
    expect(releaseEvents(h.events).sort()).toEqual(["capture.stop", "hid.close", "size.unsubscribe"]);
  });

  test("closing while the foldable probe is pending never starts a Duo monitor", async () => {
    const foldable = deferred<boolean>();
    const h = harness({ foldable: foldable.promise });
    const started = h.session.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.events).toContain("size.subscribe");
    h.session.close();
    foldable.resolve(true);
    await started.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(h.monitors).toEqual([]);
    expect(h.events).not.toContain("mjpeg.subscribe");
    expect(h.events).toContain("hid.close");
    expect(h.events).toContain("capture.stop");
  });

  test("a throwing HID close and a rejected capture stop are logged and do not skip other cleanups", async () => {
    const h = harness({
      foldable: true,
      hidClose: () => { throw new Error("modifier release failed"); },
      captureStop: async () => { throw new Error("encoder already gone"); },
    });
    await h.session.start();
    h.attach();
    h.events.length = 0;
    expect(() => h.session.close()).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(releaseEvents(h.events).sort()).toEqual([
      "mjpeg.unsubscribe",
      "monitor.close",
      "size.unsubscribe",
      "socket.close",
    ]);
    const logged = errorSpy.mock.calls.map((args) => args.map(String).join(" "));
    expect(logged).toContain("[capture] HID close failed for CLOSE-UDID: modifier release failed");
    expect(logged).toContain("[capture] capture stop failed for CLOSE-UDID: encoder already gone");
  });
});

// The first input frame of a session awaits the Device Hub shadow probe
// (`simctl spawn … notifyutil`, hundreds of ms). Shutting the simulator down
// from the grid closes the session during that wait; on a real Mac the touch
// begin then reached the injector ~0.4–0.9 s after close(). Its socket is
// gone, so no end/up could follow — a begin/down sent then could stick.
describe("DeviceSession.close drops input still waiting on the shadow probe", () => {
  const sendInputBurst = (h: ReturnType<typeof harness>) => {
    h.send(0x03, { type: "begin", x: 0.5, y: 0.5 });
    h.send(0x05, { type: "begin", x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.6 });
    h.send(0x04, { button: "lock" });
    h.send(0x04, { button: "volume-up", page: 12, usage: 233, phase: "down" });
    h.send(0x06, { type: "down", usage: 4 });
    h.send(0x0a, { delta: 1 });
    h.send(0x0b, { dx: 0, dy: 0.1 });
  };
  const inputEvents = (events: string[]) => events.filter((e) => /^hid\.(?!close)/.test(e));

  test("frames received before close are not injected once the probe settles after it", async () => {
    const probe = deferred<boolean | null>();
    const h = harness({ readShadowed: () => probe.promise });
    void h.session.start().catch(() => {});
    h.attach();
    sendInputBurst(h);
    await new Promise((r) => setTimeout(r, 5));
    h.session.close();
    probe.resolve(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(inputEvents(h.events)).toEqual([]);
  });

  test("a live session still injects the same frames once the probe settles", async () => {
    const probe = deferred<boolean | null>();
    const h = harness({ readShadowed: () => probe.promise });
    void h.session.start().catch(() => {});
    h.attach();
    sendInputBurst(h);
    await new Promise((r) => setTimeout(r, 5));
    probe.resolve(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(inputEvents(h.events)).toEqual([
      "hid.touch:begin",
      "hid.multiTouch:begin",
      "hid.button:lock",
      "hid.buttonHid",
      "hid.key:down",
      "hid.digitalCrown",
      "hid.scroll",
    ]);
    h.session.close();
  });
});
