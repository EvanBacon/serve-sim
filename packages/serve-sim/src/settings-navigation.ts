import type { AxElement, AxSnapshot } from "./ax-shared";

// Opens an app's page in Settings (or its Notifications page) by driving
// the Settings UI. No URL gets there from outside the app on iOS 26/27:
// `App-prefs:<bundleId>` stops at the Settings root, `prefs:` and
// `settings-navigation:` fail from simctl, and even the app's own
// UIApplication.openSettingsURLString lands on the root. So: relaunch
// Settings at its root, then Apps → <app> → Notifications, checking each
// screen through the accessibility tree and failing with a clear message.

export interface SettingsNavigationDeps {
  /** Terminate Settings and reopen it, so it starts at its root. */
  openSettingsRoot(): Promise<void>;
  snapshot(): Promise<AxSnapshot>;
  /** Tap at normalized (0..1) screen coords. */
  tap(point: { x: number; y: number }): Promise<void>;
  /** Drag the list so later rows come into view ("forward") or earlier ones ("back"). */
  scroll(direction: "forward" | "back"): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface SettingsNavigationTarget {
  bundleId: string;
  displayName: string;
  notifications: boolean;
}

export interface SettingsNavigationOptions {
  /** Per-screen wait for the expected screen. */
  screenTimeoutMs?: number;
  /** Bound on drags while looking for one row. */
  maxScrolls?: number;
  /** Pause after the root first appears; the first touch is dropped before it settles. */
  rootSettleMs?: number;
  pollMs?: number;
}

export interface TouchStep {
  type: "begin" | "move" | "end";
  x: number;
  y: number;
  /** Pause after this step, in ms. */
  waitMs: number;
}

/**
 * The drag `scroll` performs: 30% of the screen height, easing out to a
 * stop and holding before release, so the list doesn't fling past rows
 * (rows that scroll off screen drop out of the AX tree).
 */
export function scrollDragPath(direction: "forward" | "back"): TouchStep[] {
  const [from, to] = direction === "forward" ? [0.7, 0.4] : [0.4, 0.7];
  const steps: TouchStep[] = [{ type: "begin", x: 0.5, y: from, waitMs: 30 }];
  const moves = 8;
  for (let i = 1; i <= moves; i++) {
    const t = 1 - (1 - i / moves) ** 2;
    steps.push({ type: "move", x: 0.5, y: from + (to - from) * t, waitMs: i === moves ? 250 : 30 });
  }
  steps.push({ type: "end", x: 0.5, y: to, waitMs: 0 });
  return steps;
}

export class SettingsNavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsNavigationError";
  }
}

const SETTINGS_ID_PREFIX = "com.apple.settings.";
const APPS_ROW_ID = "com.apple.settings.apps";
const DEFAULT_APPS_ROW_ID = "com.apple.Settings.Apps.DefaultApps";

type Match = (element: AxElement) => boolean;

const isHeading = (e: AxElement) => e.role.toLowerCase() === "heading" || e.type === "Heading";
const isButton = (e: AxElement) => /button/i.test(e.role) || e.type === "Button";
const headingIs = (label: string): Match => (e) => isHeading(e) && e.label.trim() === label;

const backIs = (label: string): Match => (e) => /back/i.test(e.role) && e.label.trim() === label;
const has = (s: AxSnapshot, match: Match) => s.elements.some(match);

/**
 * Each screen, recognized only once the previous one has left the tree
 * (mid-push the tree holds both screens' rows).
 * @lintignore Exported for tests.
 */
export const screens = {
  root: (s: AxSnapshot) => has(s, headingIs("Settings")) && has(s, (e) => e.id.startsWith(SETTINGS_ID_PREFIX)),
  apps: (s: AxSnapshot) =>
    (has(s, headingIs("Apps")) || has(s, (e) => e.id === DEFAULT_APPS_ROW_ID)) &&
    !has(s, (e) => e.id.startsWith(SETTINGS_ID_PREFIX)),
  app: (displayName: string) => (s: AxSnapshot) =>
    has(s, headingIs(displayName)) && has(s, backIs("Apps")) && !has(s, (e) => e.id === DEFAULT_APPS_ROW_ID),
  notifications: (displayName: string) => (s: AxSnapshot) =>
    has(s, headingIs("Notifications")) && has(s, backIs(displayName)),
};

/** @lintignore Exported for tests. */
export const rows = {
  apps: ((e) => e.id === APPS_ROW_ID || (isButton(e) && e.label.trim() === "Apps" && !/back/i.test(e.role))) as Match,
  // Settings › Apps rows carry the bundle id as their identifier.
  app: (bundleId: string, displayName: string): Match => (e) =>
    isButton(e) && (e.id === bundleId || e.label.trim() === displayName),
  notifications: ((e) => isButton(e) && /^Notifications(,|$)/.test(e.label.trim())) as Match,
};

const NON_APP_ROWS = new Set([DEFAULT_APPS_ROW_ID, "com.apple.Settings.Apps.Hidden"]);

/**
 * Settings › Apps is sorted by name, so the app rows on screen say which
 * way a missing app is: "above" when they all sort after it, "below" when
 * they all sort before it, "absent" when it would sit between two of them.
 * @lintignore Exported for tests.
 */
export function missingAppRow(s: AxSnapshot, displayName: string): "above" | "below" | "absent" {
  const labels = s.elements
    .filter((e) => isButton(e) && !/back/i.test(e.role) && e.id.includes(".") && !NON_APP_ROWS.has(e.id) &&
      !e.id.startsWith(SETTINGS_ID_PREFIX) && e.label.trim())
    .map((e) => e.label.trim());
  if (labels.length === 0) return "below";
  const cmp = (label: string) => label.localeCompare(displayName, undefined, { sensitivity: "base" });
  const before = labels.some((l) => cmp(l) < 0);
  const after = labels.some((l) => cmp(l) > 0);
  if (before && after) return "absent";
  return after ? "above" : "below";
}

/** Where a row sits relative to the band that's safe to tap (clear of bars). */
export function rowPlacement(e: AxElement, screen: AxSnapshot["screen"]): "above" | "visible" | "below" {
  const cy = e.frame.y + e.frame.height / 2;
  if (cy < screen.height * 0.14) return "above";
  if (cy > screen.height * 0.86) return "below";
  return "visible";
}

/**
 * Same rows at the same places, within a few points (AX frames jitter by
 * a fraction of a point between reads): the screen has stopped moving.
 * @lintignore Exported for tests.
 */
export function samePositions(a: AxSnapshot, b: AxSnapshot): boolean {
  if (a.elements.length !== b.elements.length) return false;
  return a.elements.every((e, i) => {
    const o = b.elements[i]!;
    return e.id === o.id && e.label === o.label &&
      Math.abs(e.frame.y - o.frame.y) < 3 && Math.abs(e.frame.x - o.frame.x) < 3;
  });
}

/**
 * Whether a drag left the list where it was: the same rows present. Row
 * positions are ignored, so a short page's rubber-band bounce (or sub-point
 * AX jitter) still reads as "didn't move"; a 30% drag of a long list
 * always brings rows in or out.
 * @lintignore Exported for tests.
 */
export function sameRows(a: AxSnapshot, b: AxSnapshot): boolean {
  const key = (s: AxSnapshot) => s.elements.map((e) => `${e.id}\u0000${e.label}`).join("\n");
  return key(a) === key(b);
}

export async function navigateToAppSettings(
  target: SettingsNavigationTarget,
  deps: SettingsNavigationDeps,
  opts: SettingsNavigationOptions = {},
): Promise<void> {
  const screenTimeoutMs = opts.screenTimeoutMs ?? 6_000;
  const maxScrolls = opts.maxScrolls ?? 12;
  const pollMs = opts.pollMs ?? 250;
  const name = target.displayName;

  /**
   * Reads until two in a row put every row in the same place. The in-process
   * AX read is fast enough to catch a list still moving after a drag or a
   * push, and a tap aimed from that read misses the row.
   */
  const settled = async (first: AxSnapshot): Promise<AxSnapshot> => {
    let prev = first;
    for (let i = 0; i < 10; i++) {
      await deps.sleep(120);
      const next = await deps.snapshot();
      if (samePositions(prev, next)) return next;
      prev = next;
    }
    return prev;
  };

  const waitFor = async (isScreen: (s: AxSnapshot) => boolean, what: string): Promise<AxSnapshot> => {
    const deadline = deps.now() + screenTimeoutMs;
    for (;;) {
      const s = await deps.snapshot();
      if (isScreen(s)) {
        const still = await settled(s);
        if (isScreen(still)) return still;
      }
      if (deps.now() >= deadline) throw new SettingsNavigationError(`Settings didn't show ${what}`);
      await deps.sleep(pollMs);
    }
  };

  /** Bring a matching row into the tappable band and tap it; false if absent. */
  const findAndTap = async (
    match: Match,
    initial: AxSnapshot,
    limit = maxScrolls,
    whereMissing: (s: AxSnapshot) => "above" | "below" | "absent" = () => "below",
  ): Promise<boolean> => {
    let s = initial;
    let stuck = 0;
    for (let scrolls = 0; ; scrolls++) {
      const row = s.elements.find(match);
      const placement = row ? rowPlacement(row, s.screen) : whereMissing(s);
      if (placement === "absent") return false;
      if (row && placement === "visible") {
        await deps.tap({
          x: (row.frame.x + row.frame.width / 2) / s.screen.width,
          y: (row.frame.y + row.frame.height / 2) / s.screen.height,
        });
        return true;
      }
      if (scrolls >= limit) return false;
      await deps.scroll(placement === "above" ? "back" : "forward");
      await deps.sleep(150);
      const next = await settled(await deps.snapshot());
      // A drag that moves nothing is either a dropped touch or the list's
      // end; allow one retry before calling it the end.
      if (sameRows(next, s)) {
        if (++stuck >= 2) return false;
      } else {
        stuck = 0;
      }
      s = next;
    }
  };

  await deps.openSettingsRoot();
  await waitFor(screens.root, "its main list");
  await deps.sleep(opts.rootSettleMs ?? 1_000);

  if (!(await findAndTap(rows.apps, await deps.snapshot()))) {
    throw new SettingsNavigationError("Couldn't find Apps in Settings");
  }
  const appsList = await waitFor(screens.apps, "the Apps list");

  // The Apps list holds every installed app, so it gets a longer bound.
  if (!(await findAndTap(rows.app(target.bundleId, name), appsList, maxScrolls * 3, (s) => missingAppRow(s, name)))) {
    throw new SettingsNavigationError(`${name} isn't listed in Settings › Apps`);
  }
  const appPage = await waitFor(screens.app(name), `${name}'s settings`);
  if (!target.notifications) return;

  if (!(await findAndTap(rows.notifications, appPage))) {
    throw new SettingsNavigationError(`${name} hasn't registered for notifications`);
  }
  await waitFor(screens.notifications(name), `${name}'s notification settings`);
}
