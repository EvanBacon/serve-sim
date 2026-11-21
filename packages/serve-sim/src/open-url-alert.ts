import type { AxElement, AxSnapshot } from "./ax-shared";

// iOS 27 asks before a custom-scheme URL opened from outside an app
// reaches it: a system alert `Open in “<App>”?` with Cancel / Open. Every
// `simctl openurl` queues its own alert, so unanswered ones stack up and
// cover whatever comes next (Spotlight, Settings). The Linking tool taps
// Open after its own `openUrl` (the user asked to open the link) and
// cancels stray ones before driving the UI.

export interface AlertDeps {
  snapshot(): Promise<AxSnapshot>;
  /** Tap at normalized (0..1) screen coords. */
  tap(point: { x: number; y: number }): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface OpenInAlert {
  title: string;
  open: AxElement;
  cancel: AxElement | null;
}

const isButton = (e: AxElement) => /button/i.test(e.role) || e.type === "Button";

/** The `Open in “…”?` confirmation on screen, or null. */
export function findOpenInAlert(s: AxSnapshot): OpenInAlert | null {
  const title = s.elements.find((e) => /^Open in\b/.test(e.label.trim()) && !isButton(e));
  if (!title) return null;
  const open = s.elements.find((e) => isButton(e) && e.label.trim() === "Open");
  if (!open) return null;
  const cancel = s.elements.find((e) => isButton(e) && e.label.trim() === "Cancel") ?? null;
  return { title: title.label.trim(), open, cancel };
}

function center(e: AxElement, s: AxSnapshot) {
  return {
    x: (e.frame.x + e.frame.width / 2) / s.screen.width,
    y: (e.frame.y + e.frame.height / 2) / s.screen.height,
  };
}

/** Gap after a tap before reading again: the alert's dismiss animation. */
const AFTER_TAP_MS = 700;

export type ConfirmResult = "none" | "opened" | "stuck";

/**
 * After an `openurl`: wait briefly for the confirmation and tap Open.
 * "none" when no alert showed within `appearMs` (it shows in ~150 ms when
 * it's coming), "opened" once it's gone, "stuck" if it outlasts
 * `timeoutMs`.
 */
export async function confirmOpenInAlert(
  deps: AlertDeps,
  opts: { appearMs?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<ConfirmResult> {
  const start = deps.now();
  const appearMs = opts.appearMs ?? 1_500;
  const deadline = start + (opts.timeoutMs ?? 3_000);
  const pollMs = opts.pollMs ?? 150;
  let tapped = false;
  for (;;) {
    const s = await deps.snapshot();
    const alert = findOpenInAlert(s);
    if (!alert) {
      if (tapped) return "opened";
      if (deps.now() - start >= appearMs) return "none";
    } else if (deps.now() < deadline) {
      await deps.tap(center(alert.open, s));
      tapped = true;
      await deps.sleep(AFTER_TAP_MS);
      continue;
    }
    if (deps.now() >= deadline) return tapped ? "stuck" : "none";
    await deps.sleep(pollMs);
  }
}

export class StuckAlertError extends Error {
  constructor(title: string) {
    super(`A system alert (${title}) is in the way and didn't close`);
    this.name = "StuckAlertError";
  }
}

/**
 * Cancel any stacked `Open in …?` alerts (bounded), so UI-driving tokens
 * start on a clear screen. Resolves to how many were cancelled; throws
 * StuckAlertError when they don't clear.
 */
export async function dismissOpenInAlerts(
  deps: AlertDeps,
  opts: { max?: number; timeoutMs?: number } = {},
): Promise<number> {
  const max = opts.max ?? 6;
  const deadline = deps.now() + (opts.timeoutMs ?? 6_000);
  let cancelled = 0;
  for (;;) {
    const s = await deps.snapshot();
    const alert = findOpenInAlert(s);
    if (!alert) return cancelled;
    // Never answer "Open" on the user's behalf here: no Cancel, no tap.
    if (!alert.cancel || cancelled >= max || deps.now() >= deadline) throw new StuckAlertError(alert.title);
    await deps.tap(center(alert.cancel, s));
    cancelled++;
    await deps.sleep(AFTER_TAP_MS);
  }
}
