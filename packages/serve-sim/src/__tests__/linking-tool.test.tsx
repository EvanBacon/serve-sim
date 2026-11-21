import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkingTool } from "../client/components/linking-tool";
import { LINKING_HISTORY_STORAGE_KEY, SYSTEM_HISTORY_KEY, isSystemSurface, linkingTarget } from "../client/utils/linking";

const UDID = "11111111-2222-3333-4444-555555555555";
const host = async () => ({ stdout: "", stderr: "", exitCode: 0 });

function storageWith(value: unknown) {
  const raw = JSON.stringify(value);
  return { getItem: (k: string) => (k === LINKING_HISTORY_STORAGE_KEY ? raw : null), setItem: () => {} };
}

describe("LinkingTool", () => {
  test("renders a muted Linking section with the bar and token chips", () => {
    const html = renderToStaticMarkup(<LinkingTool udid={UDID} bundleId="com.example.app" host={host} storage={null} />);
    expect(html).toContain('data-testid="linking-tool"');
    expect(html).toContain("text-ink-50 uppercase");
    expect(html).toContain(">Linking<");
    expect(html).toContain('data-testid="linking-bar"');
    expect(html).toContain('placeholder="Open URL"');
    for (const action of ["spotlight", "launch", "terminate", "settings", "notificationSettings"]) {
      expect(html).toContain(`data-linking-action="${action}"`);
    }
    expect(html).toContain(">Search<");
    expect(html).toContain(">Notification Settings<");
    // No history yet: no Recent list or Clear button.
    expect(html).not.toContain('data-testid="linking-history"');
    expect(html).not.toContain(">Clear<");
  });

  test("shows the app's URL schemes as chips", () => {
    const html = renderToStaticMarkup(
      <LinkingTool
        udid={UDID}
        bundleId="com.example.app"
        host={host}
        storage={null}
        initialInfo={{ displayName: "Example", schemes: ["example", "example-dev"], domains: ["example.com"] }}
      />,
    );
    expect(html).toContain('data-linking-scheme="example"');
    expect(html).toContain(">example://</button>");
    // Universal-link hosts and schemes autocomplete in the bar.
    expect(html).toContain('<option value="https://example.com/">');
    expect(html).toContain('data-linking-scheme="example-dev"');
  });

  test("lists this app's history newest first with a Clear button", () => {
    const storage = storageWith({
      "com.example.app": [
        { kind: "url", url: "example://item/42" },
        { kind: "action", action: "spotlight", query: "Example" },
        { kind: "action", action: "settings" },
      ],
      "com.other.app": [{ kind: "url", url: "other://nope" }],
    });
    const html = renderToStaticMarkup(<LinkingTool udid={UDID} bundleId="com.example.app" host={host} storage={storage} />);
    expect(html).toContain('data-testid="linking-history"');
    expect(html).toContain(">Recent<");
    expect(html).toContain(">Clear<");
    const recent = html.slice(html.indexOf('data-testid="linking-history"'));
    const order = ["example://item/42", "Search “Example”", "App Settings"].map((s) => recent.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("other://nope");
  });

  test("renders nothing without a foreground app", () => {
    expect(renderToStaticMarkup(<LinkingTool udid={UDID} bundleId={null} host={host} storage={null} />)).toBe("");
  });
});

describe("isSystemSurface", () => {
  test("system UI the tokens and alerts bring up is never a target", () => {
    for (const id of [
      "com.apple.springboard", "com.apple.Spotlight", "com.apple.Preferences", "com.apple.PosterBoard",
      "com.apple.InCallService", "com.apple.SafariViewService",
    ]) expect(isSystemSurface(id)).toBe(true);
  });

  test("real apps, Apple's included, are targets", () => {
    for (const id of ["com.servesim.permdemo.camera", "com.apple.mobilesafari", "com.apple.Maps", "com.apple.springboardx", "com.apple.spotlight"]) {
      expect(isSystemSurface(id)).toBe(false);
    }
    expect(isSystemSurface(null)).toBe(false);
    expect(isSystemSurface(undefined)).toBe(false);
  });
});

describe("linkingTarget", () => {
  test("stays on the app while Search, Settings or Home is in front", () => {
    expect(linkingTarget("com.example.app", null)).toBe("com.example.app");
    for (const surface of ["com.apple.Spotlight", "com.apple.Preferences", "com.apple.springboard", "com.apple.PosterBoard"]) {
      expect(linkingTarget(surface, "com.example.app")).toBe("com.example.app");
    }
    expect(linkingTarget("com.other.app", "com.example.app")).toBe("com.other.app");
    // Detection gaps don't drop the target either.
    expect(linkingTarget(null, "com.example.app")).toBe("com.example.app");
  });

  test("no real app yet: no target, even if a surface was 'previous'", () => {
    expect(linkingTarget("com.apple.Spotlight", null)).toBeNull();
    expect(linkingTarget("com.apple.springboard", "com.apple.Preferences")).toBeNull();
    expect(linkingTarget(null, null)).toBeNull();
  });

  test("the header names the target app", () => {
    const html = renderToStaticMarkup(
      <LinkingTool udid={UDID} bundleId="com.example.app" host={host} storage={null} initialInfo={{ displayName: "Example", schemes: [], domains: [] }} />,
    );
    expect(html).toMatch(/data-testid="linking-target">Example</);
  });
});

describe("LinkingTool without a real app", () => {
  test("a system surface first: shows the bar, no schemes, app tokens disabled, Search enabled", () => {
    const html = renderToStaticMarkup(<LinkingTool udid={UDID} bundleId="com.apple.Spotlight" host={host} storage={null} />);
    expect(html).toContain('data-testid="linking-bar"');
    expect(html).not.toContain("data-linking-scheme");
    const chip = (action: string) => new RegExp(`<button[^>]*data-linking-action="${action}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(chip("spotlight")).toContain("spotlight");
    expect(chip("spotlight")).not.toContain('disabled=""');
    for (const action of ["launch", "terminate", "settings", "notificationSettings"]) {
      expect(chip(action)).toContain('disabled=""');
      expect(chip(action)).toContain('title="Open an app first"');
    }
    expect(html).toMatch(/data-testid="linking-target"><\/span>/);
  });

  test("uses its own history, with app-only entries disabled", () => {
    const storage = storageWith({
      [SYSTEM_HISTORY_KEY]: [{ kind: "url", url: "https://example.com" }, { kind: "action", action: "launch" }],
      "com.apple.Spotlight": [{ kind: "url", url: "spot://never" }],
    });
    const html = renderToStaticMarkup(<LinkingTool udid={UDID} bundleId="com.apple.Spotlight" host={host} storage={storage} />);
    expect(html).toContain("https://example.com");
    expect(html).not.toContain("spot://never");
    const launchRow = /<button[^>]*title="Run Launch"[^>]*>/.exec(html)?.[0] ?? "";
    expect(launchRow).toContain('disabled=""');
    const urlRow = /<button[^>]*title="Open https:\/\/example.com"[^>]*>/.exec(html)?.[0] ?? "";
    expect(urlRow).toContain("Open https://example.com");
    expect(urlRow).not.toContain('disabled=""');
  });
});
