import { simEndpoint } from "./sim-endpoint";

export interface WebKitDevtoolsTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  appName?: string;
  bundleId?: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl: string;
  inUseByOtherInspector?: boolean;
}

export interface WebKitDevtoolsResponse {
  port: number;
  targets: WebKitDevtoolsTarget[];
  error?: string;
}

// Fire-and-forget highlight nudge — mirrors Safari's Develop menu hover. The
// caller doesn't await so cursor latency stays at zero; failures are silent.
export function postHighlightTarget(targetId: string, on: boolean) {
  void fetch(simEndpoint("devtools/highlight"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId, on }),
    keepalive: true,
  }).catch(() => {});
}

// Tell the bridge to drop any cached hover sessions for this picker. Called
// on close / unmount / pagehide so we don't camp on a WIR slot the user no
// longer cares about. `sendBeacon` survives pagehide where `fetch` may not.
export function postReleaseHighlights() {
  const url = simEndpoint("devtools/release");
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const blob = new Blob(["{}"], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    }
  } catch {}
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    keepalive: true,
  }).catch(() => {});
}

// WebKit doesn't supply a screencast feed, so the embedded Chrome DevTools'
// screencast pane is dead space. Click the "Toggle screencast" toolbar button
// once the iframe loads to collapse it. The button lives inside DevTools'
// shadow DOM, so we walk shadow roots to find it.
export function collapseScreencastPane(iframe: HTMLIFrameElement) {
  const root = iframe.contentDocument;
  if (!root) return;
  const find = (): HTMLElement | null => {
    const stack: ParentNode[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      const candidates = node.querySelectorAll<HTMLElement>("[aria-label],[title]");
      for (const el of candidates) {
        const label = el.getAttribute("aria-label") || el.title || "";
        if (/^toggle screencast$/i.test(label)) return el;
      }
      for (const el of node.querySelectorAll<HTMLElement>("*")) {
        if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
    return null;
  };
  let attempts = 0;
  const tick = () => {
    attempts++;
    const btn = find();
    if (btn && btn.getAttribute("aria-pressed") !== "false") {
      btn.click();
      return;
    }
    if (attempts < 20) setTimeout(tick, 100);
  };
  tick();
}
