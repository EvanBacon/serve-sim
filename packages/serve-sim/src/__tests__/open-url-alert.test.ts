import { describe, expect, test } from "bun:test";
import type { AxElement, AxSnapshot } from "../ax-shared";
import {
  StuckAlertError,
  confirmOpenInAlert,
  dismissOpenInAlerts,
  findOpenInAlert,
  type AlertDeps,
} from "../open-url-alert";

const SCREEN = { width: 402, height: 874 };

function el(label: string, role: string, frame: { x: number; y: number; w: number; h: number }): AxElement {
  return {
    id: `p.${label}`, path: `p.${label}`, label, value: "", role,
    type: role === "button" ? "Button" : role === "text" ? "StaticText" : "GenericElement",
    enabled: true, frame: { x: frame.x, y: frame.y, width: frame.w, height: frame.h },
  };
}

// The alert exactly as iOS 27.2 exposes it (captured on the simulator).
const ALERT: AxSnapshot = {
  screen: SCREEN,
  elements: [
    el("Open in “Camera Demo”?", "text", { x: 71, y: 409.67, w: 260, h: 20.33 }),
    el("Cancel", "button", { x: 57, y: 450, w: 140, h: 48 }),
    el("Open", "button", { x: 205, y: 450, w: 140, h: 48 }),
    el("Dynamic Island, Empty", "", { x: 138, y: 14, w: 125, h: 37 }),
  ],
};
const APP: AxSnapshot = {
  screen: SCREEN,
  elements: [el("Camera Demo", "heading", { x: 16, y: 74, w: 200, h: 21 }), el("Open", "button", { x: 16, y: 300, w: 100, h: 44 })],
};

/** Fake screen: a stack of `pending` alerts over the app; each tap on a button pops one. */
function fakeScreen(alerts: number, opts: { tapsIgnored?: boolean; appearAfterMs?: number } = {}) {
  let clock = 0;
  let pending = opts.appearAfterMs === undefined ? alerts : 0;
  const taps: string[] = [];
  const deps: AlertDeps = {
    async snapshot() {
      if (opts.appearAfterMs !== undefined && clock >= opts.appearAfterMs && taps.length === 0) pending = alerts;
      clock += 100; // a read costs time
      return pending > 0 ? ALERT : APP;
    },
    async tap({ x, y }) {
      const px = x * SCREEN.width;
      const py = y * SCREEN.height;
      const hit = ALERT.elements.find((e) => e.role === "button" && px >= e.frame.x && px <= e.frame.x + e.frame.width && py >= e.frame.y && py <= e.frame.y + e.frame.height);
      taps.push(hit?.label ?? "miss");
      if (!opts.tapsIgnored && pending > 0) pending--;
    },
    async sleep(ms) { clock += ms; },
    now: () => clock,
  };
  return { deps, taps, clock: () => clock };
}

describe("findOpenInAlert", () => {
  test("recognizes the confirmation and its buttons", () => {
    const alert = findOpenInAlert(ALERT);
    expect(alert?.title).toBe("Open in “Camera Demo”?");
    expect(alert?.open.label).toBe("Open");
    expect(alert?.cancel?.label).toBe("Cancel");
  });

  test("ignores an app that merely has an Open button", () => {
    expect(findOpenInAlert(APP)).toBeNull();
    expect(findOpenInAlert({ screen: SCREEN, elements: [el("Open in “X”?", "text", { x: 0, y: 0, w: 1, h: 1 })] })).toBeNull();
    expect(findOpenInAlert({ screen: SCREEN, elements: [] })).toBeNull();
  });
});

describe("confirmOpenInAlert", () => {
  test("taps Open on the confirmation and returns once it's gone", async () => {
    const { deps, taps } = fakeScreen(1);
    expect(await confirmOpenInAlert(deps)).toBe("opened");
    expect(taps).toEqual(["Open"]);
  });

  test("catches an alert that shows a moment later", async () => {
    const { deps, taps } = fakeScreen(1, { appearAfterMs: 300 });
    expect(await confirmOpenInAlert(deps)).toBe("opened");
    expect(taps).toEqual(["Open"]);
  });

  test("returns quickly when no alert comes", async () => {
    const { deps, taps, clock } = fakeScreen(0);
    expect(await confirmOpenInAlert(deps, { appearMs: 1500, timeoutMs: 3000 })).toBe("none");
    expect(taps).toEqual([]);
    expect(clock()).toBeLessThan(2000);
  });

  test("gives up within the timeout when the alert never clears", async () => {
    const { deps, taps, clock } = fakeScreen(1, { tapsIgnored: true });
    expect(await confirmOpenInAlert(deps, { timeoutMs: 3000 })).toBe("stuck");
    expect(taps.length).toBeGreaterThan(1);
    expect(taps.every((t) => t === "Open")).toBe(true);
    expect(clock()).toBeLessThan(4000);
  });
});

describe("dismissOpenInAlerts", () => {
  test("does nothing on a clear screen", async () => {
    const { deps, taps } = fakeScreen(0);
    expect(await dismissOpenInAlerts(deps)).toBe(0);
    expect(taps).toEqual([]);
  });

  test("cancels every stacked alert (one per earlier openurl)", async () => {
    const { deps, taps } = fakeScreen(3);
    expect(await dismissOpenInAlerts(deps)).toBe(3);
    expect(taps).toEqual(["Cancel", "Cancel", "Cancel"]);
  });

  test("is bounded when the alert won't go away", async () => {
    const { deps, taps } = fakeScreen(1, { tapsIgnored: true });
    await expect(dismissOpenInAlerts(deps, { max: 4 })).rejects.toBeInstanceOf(StuckAlertError);
    expect(taps).toEqual(["Cancel", "Cancel", "Cancel", "Cancel"]);
  });

  test("never taps Open when there's no Cancel", async () => {
    const noCancel: AxSnapshot = { screen: SCREEN, elements: ALERT.elements.filter((e) => e.label !== "Cancel") };
    const taps: unknown[] = [];
    const deps: AlertDeps = { snapshot: async () => noCancel, tap: async (p) => { taps.push(p); }, sleep: async () => {}, now: () => 0 };
    await expect(dismissOpenInAlerts(deps)).rejects.toThrow("didn't close");
    expect(taps).toEqual([]);
  });
});
