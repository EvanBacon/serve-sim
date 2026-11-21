import { describe, expect, test } from "bun:test";
import type { AxElement, AxSnapshot } from "../ax-shared";
import {
  missingAppRow,
  navigateToAppSettings,
  rowPlacement,
  sameRows,
  scrollDragPath,
  type SettingsNavigationDeps,
} from "../settings-navigation";

// A fake Settings app: a stack of scrollable screens rendered as AX
// snapshots (rows off screen drop out of the tree, like UIKit's recycled
// cells), driven by taps and drags at normalized coords.

const SCREEN = { width: 402, height: 874 };
const ROW_H = 52;
const LIST_TOP = 150;

interface Row { id: string; label: string; role?: string; to?: string }
interface Screen { heading: string; back?: string; rows: Row[]; offset: number }

function el(partial: Partial<AxElement> & { label: string; role: string; y: number; h?: number }): AxElement {
  return {
    id: partial.id ?? `path.${partial.label}`,
    path: `path.${partial.label}`,
    label: partial.label,
    value: "",
    role: partial.role,
    type: partial.role === "heading" ? "Heading" : "Button",
    enabled: true,
    frame: { x: 16, y: partial.y, width: 370, height: partial.h ?? ROW_H },
  };
}

function fakeSettings(screens: Record<string, Omit<Screen, "offset">>, opts: { dropFirstTouches?: number } = {}) {
  const log: string[] = [];
  let stack: Screen[] = [];
  let dropped = 0;
  let clock = 0;
  const top = () => stack[stack.length - 1];

  const render = (): AxSnapshot => {
    const s = top();
    if (!s) return { screen: SCREEN, elements: [] };
    const elements: AxElement[] = [];
    if (s.back) elements.push({ ...el({ label: s.back, role: "back button", y: 62, h: 44 }), id: "BackButton" });
    elements.push(el({ label: s.heading, role: "heading", y: 74, h: 21 }));
    s.rows.forEach((row, i) => {
      const y = LIST_TOP + i * ROW_H - s.offset;
      if (y + ROW_H < 0 || y > SCREEN.height) return;
      elements.push(el({ id: row.id, label: row.label, role: row.role ?? "button", y }));
    });
    return { screen: SCREEN, elements };
  };

  const maxOffset = (s: Screen) => Math.max(0, LIST_TOP + s.rows.length * ROW_H - SCREEN.height * 0.8);

  const deps: SettingsNavigationDeps = {
    async openSettingsRoot() {
      log.push("open");
      stack = [{ ...screens.root!, offset: 0 }];
    },
    async snapshot() { return render(); },
    async tap({ x, y }) {
      if (dropped < (opts.dropFirstTouches ?? 0)) { dropped++; log.push("tap(dropped)"); return; }
      const s = top()!;
      const py = y * SCREEN.height;
      const index = Math.floor((py + s.offset - LIST_TOP) / ROW_H);
      const row = s.rows[index];
      log.push(`tap ${row?.label ?? "nothing"}`);
      expect(x).toBeGreaterThan(0);
      if (row?.to) stack.push({ ...screens[row.to]!, offset: 0 });
    },
    async scroll(direction) {
      if (dropped < (opts.dropFirstTouches ?? 0)) { dropped++; log.push("scroll(dropped)"); return; }
      const s = top()!;
      const delta = SCREEN.height * 0.3 * (direction === "forward" ? 1 : -1);
      s.offset = Math.min(maxOffset(s), Math.max(0, s.offset + delta));
      log.push(`scroll ${direction}`);
    },
    async sleep(ms) { clock += ms; },
    now: () => clock,
  };
  return { deps, log, top };
}

const ROOT_ROWS: Row[] = [
  "Apple Account", "General", "Accessibility", "Action Button", "Appearance", "Camera", "Home Screen", "Search",
  "Siri", "StandBy", "Screen Time", "Passcode", "Privacy & Security", "Game Center", "iCloud",
].map((label) => ({ id: `com.apple.settings.${label.replace(/\W/g, "")}`, label }));

function appsRows(names: string[]): Row[] {
  return [
    { id: "com.apple.Settings.Apps.DefaultApps", label: "Default Apps" },
    ...names.map((name) => ({ id: `com.example.${name.replace(/\W/g, "").toLowerCase()}`, label: name, to: `app:${name}` })),
    { id: "com.apple.Settings.Apps.Hidden", label: "Hidden Apps" },
  ];
}

const MANY_APPS = [
  "Calendar", "Camera Demo", "Contacts", "Files", "Fitness", "Health", "Maps", "Messages", "News", "Passwords",
  "Photos", "Preview", "Reminders", "Remote", "Safari", "Shortcuts", "Wallet", "Weather", "Zebra",
];

function settingsWith(appNames: string[], appPages: Record<string, Row[]> = {}) {
  const screens: Record<string, Omit<Screen, "offset">> = {
    root: { heading: "Settings", rows: [...ROOT_ROWS, { id: "com.apple.settings.apps", label: "Apps", to: "apps" }, { id: "com.apple.settings.developer", label: "Developer" }] },
    apps: { heading: "Apps", back: "Settings", rows: appsRows(appNames) },
    notifications: { heading: "Notifications", back: "Zebra", rows: [{ id: "ALLOW", label: "Allow Notifications", role: "switch" }] },
  };
  for (const name of appNames) {
    screens[`app:${name}`] = { heading: name, back: "Apps", rows: appPages[name] ?? [{ id: "CONTACTS", label: "Contacts, Full Access" }] };
  }
  return screens;
}

const target = (displayName: string, notifications = false) => ({
  bundleId: `com.example.${displayName.replace(/\W/g, "").toLowerCase()}`,
  displayName,
  notifications,
});

describe("navigateToAppSettings", () => {
  test("Settings root → Apps → the app, scrolling to each row", async () => {
    const { deps, log, top } = fakeSettings(settingsWith(MANY_APPS));
    await navigateToAppSettings(target("Wallet"), deps);
    expect(top()!.heading).toBe("Wallet");
    expect(log[0]).toBe("open");
    expect(log).toContain("tap Apps");
    expect(log.at(-1)).toBe("tap Wallet");
    expect(log.filter((l) => l.startsWith("scroll")).length).toBeGreaterThan(2);
  });

  test("opens the Notifications page when the app has one", async () => {
    const screens = settingsWith(MANY_APPS, {
      Zebra: [{ id: "NOTIF", label: "Notifications, Banners, Sounds, Badges", to: "notifications" }],
    });
    const { deps, log, top } = fakeSettings(screens);
    await navigateToAppSettings(target("Zebra", true), deps);
    expect(top()!.heading).toBe("Notifications");
    expect(log.at(-1)).toBe("tap Notifications, Banners, Sounds, Badges");
  });

  test("reports an app that hasn't registered for notifications", async () => {
    const { deps } = fakeSettings(settingsWith(MANY_APPS));
    await expect(navigateToAppSettings(target("Zebra", true), deps)).rejects.toThrow("Zebra hasn't registered for notifications");
  });

  test("reports an app missing from the Apps list without scrolling it all", async () => {
    const { deps, log } = fakeSettings(settingsWith(MANY_APPS));
    await expect(navigateToAppSettings(target("Mzz Nope"), deps)).rejects.toThrow("Mzz Nope isn't listed in Settings › Apps");
    const afterApps = log.slice(log.indexOf("tap Apps"));
    expect(afterApps.filter((l) => l.startsWith("scroll")).length).toBeLessThan(6);
  });

  test("an app after the last row fails at the end of the list", async () => {
    const { deps } = fakeSettings(settingsWith(MANY_APPS));
    await expect(navigateToAppSettings(target("Zzz"), deps)).rejects.toThrow("Zzz isn't listed");
  });

  test("retries a drag that didn't register", async () => {
    const { deps, log, top } = fakeSettings(settingsWith(MANY_APPS), { dropFirstTouches: 1 });
    await navigateToAppSettings(target("Camera Demo"), deps);
    expect(log).toContain("scroll(dropped)");
    expect(top()!.heading).toBe("Camera Demo");
  });

  test("times out with a clear message when a screen never appears", async () => {
    const screens = settingsWith(MANY_APPS);
    screens.apps = { heading: "Somewhere else", rows: [] };
    const { deps } = fakeSettings(screens);
    await expect(navigateToAppSettings(target("Wallet"), deps, { screenTimeoutMs: 1000 })).rejects.toThrow(
      "Settings didn't show the Apps list",
    );
  });

  test("an app page that never renders (empty AX) fails instead of guessing", async () => {
    const screens = settingsWith(MANY_APPS, {});
    screens["app:Maps"] = { heading: "", back: "Apps", rows: [] };
    const { deps } = fakeSettings(screens);
    await expect(navigateToAppSettings(target("Maps"), deps, { screenTimeoutMs: 1000 })).rejects.toThrow(
      "Settings didn't show Maps's settings",
    );
  });

  test("fails when Settings has no Apps row", async () => {
    const screens = settingsWith(MANY_APPS);
    screens.root = { heading: "Settings", rows: ROOT_ROWS };
    const { deps } = fakeSettings(screens);
    await expect(navigateToAppSettings(target("Wallet"), deps)).rejects.toThrow("Couldn't find Apps in Settings");
  });
});

describe("helpers", () => {
  const snap = (labels: Array<[string, string, number]>): AxSnapshot => ({
    screen: SCREEN,
    elements: labels.map(([id, label, y]) => el({ id, label, role: "button", y })),
  });

  test("missingAppRow uses the list's alphabetical order", () => {
    const s = snap([["com.a.maps", "Maps", 300], ["com.a.messages", "Messages", 352], ["com.apple.Settings.Apps.Hidden", "Hidden Apps", 404]]);
    expect(missingAppRow(s, "Calendar")).toBe("above");
    expect(missingAppRow(s, "Wallet")).toBe("below");
    expect(missingAppRow(s, "Mazda")).toBe("absent");
    expect(missingAppRow(snap([]), "Anything")).toBe("below");
    // Rows left over from the Settings root mid-push don't count.
    expect(missingAppRow(snap([["com.apple.settings.siri", "Siri", 300], ["com.a.maps", "Maps", 400]]), "Safari")).toBe("below");
  });

  test("rowPlacement keeps taps clear of the nav and search bars", () => {
    const at = (y: number) => rowPlacement(el({ label: "x", role: "button", y }), SCREEN);
    expect(at(40)).toBe("above");
    expect(at(400)).toBe("visible");
    expect(at(815)).toBe("below");
  });

  test("sameRows ignores sub-point jitter and bounce", () => {
    const a = snap([["a", "A", 148.4], ["b", "B", 200]]);
    expect(sameRows(a, snap([["a", "A", 149.1], ["b", "B", 230]]))).toBe(true);
    expect(sameRows(a, snap([["b", "B", 100], ["c", "C", 152]]))).toBe(false);
  });

  test("scrollDragPath eases to a stop and holds before release", () => {
    const path = scrollDragPath("forward");
    expect(path[0]).toMatchObject({ type: "begin", y: 0.7 });
    expect(path.at(-1)).toMatchObject({ type: "end", y: 0.4 });
    expect(path.at(-2)!.waitMs).toBeGreaterThanOrEqual(200);
    const ys = path.map((p) => p.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeLessThanOrEqual(ys[i - 1]!);
    const back = scrollDragPath("back");
    expect(back[0]!.y).toBe(0.4);
    expect(back.at(-1)!.y).toBe(0.7);
  });
});
