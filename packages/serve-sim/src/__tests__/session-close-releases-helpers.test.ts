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
    multiTouch: async () => true,
    button: async () => true,
    buttonHid: async () => true,
    key: async () => {},
    scroll: async () => {},
    digitalCrown: async () => {},
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
    readDeviceHubInputShadowed: async () => false,
    rollingBuffer: null,
    createDuoMonitor: (udid) => {
      monitors.push(udid);
      events.push("monitor.create");
      return { close() { events.push("monitor.close"); }, refreshOrientation() {} };
    },
  });
  const attach = () =>
    session.attachHidSocket({
      send() {},
      close() { events.push("socket.close"); },
      on() {},
    } as never);
  return { session, events, monitors, attach };
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
