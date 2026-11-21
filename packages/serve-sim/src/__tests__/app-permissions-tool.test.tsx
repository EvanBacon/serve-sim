import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppPermissionsLoading,
  AppPermissionsTool,
  PermissionsList,
} from "../client/components/app-permissions-tool";
import { PERMISSION_SERVICES } from "../client/utils/permissions";

describe("AppPermissionsLoading", () => {
  test("uses the collapsed permissions row footprint with a loading indicator", () => {
    const html = renderToStaticMarkup(<AppPermissionsLoading />);

    expect(html).toContain('data-testid="app-permissions-loading"');
    expect(html).toContain("bg-panel rounded-[10px] px-3 py-2");
    expect(html).toContain("Permissions");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-testid="permissions-loading-indicator"');
    expect(html).toContain("animate-[grid-spin_0.7s_linear_infinite]");
    expect(html).not.toContain("border-dashed");
    expect(html).not.toContain("Permissions appear once an app is in the foreground");
  });

  test("renders for the permissions tool while foreground app data is missing", () => {
    const html = renderToStaticMarkup(
      <AppPermissionsTool udid="booted" bundleId={null} />,
    );

    expect(html).toContain('data-testid="app-permissions-loading"');
    expect(html).toContain('data-testid="permissions-loading-indicator"');
    expect(html).not.toContain("Permissions appear once an app is in the foreground");
  });
});

describe("PermissionsList", () => {
  const noop = () => {};
  const render = (props: Partial<Parameters<typeof PermissionsList>[0]>) =>
    renderToStaticMarkup(
      <PermissionsList requested={null} statuses={{}} pending={null} onApply={noop} {...props} />,
    );
  const row = (html: string, key: string) => {
    const start = html.indexOf(`data-permission="${key}"`);
    expect(start).toBeGreaterThan(-1);
    const next = html.indexOf("data-permission=", start + 1);
    return html.slice(start, next === -1 ? undefined : next);
  };
  const pressed = (html: string, key: string) =>
    [...row(html, key).matchAll(/aria-label="(Allow|Deny|Reset)" aria-pressed="true"/g)].map((m) => m[1]);

  test("splits requested permissions from the rest", () => {
    const html = render({ requested: ["camera", "location"] });
    const requestedAt = html.indexOf("Requested by app");
    const allAt = html.indexOf("All permissions");
    expect(requestedAt).toBeGreaterThan(-1);
    expect(allAt).toBeGreaterThan(requestedAt);
    expect(html.indexOf('data-permission="camera"')).toBeLessThan(allAt);
    expect(html.indexOf('data-permission="location"')).toBeLessThan(allAt);
    expect(html.indexOf('data-permission="microphone"')).toBeGreaterThan(allAt);
    expect(html.match(/data-permission=/g)).toHaveLength(17);
  });

  test("highlights the real status", () => {
    const html = render({
      requested: [],
      statuses: { camera: "granted", microphone: "denied", contacts: "unset" },
    });
    expect(pressed(html, "camera")).toEqual(["Allow"]);
    expect(pressed(html, "microphone")).toEqual(["Deny"]);
    expect(pressed(html, "contacts")).toEqual([]);
    expect(pressed(html, "siri")).toEqual([]);
  });

  test("limited photos highlights Allow and adds a Limited tag", () => {
    const html = render({ requested: ["photos"], statuses: { photos: "limited", camera: "granted" } });
    expect(pressed(html, "photos")).toEqual(["Allow"]);
    expect(row(html, "photos")).toContain("Limited");
    expect(row(html, "camera")).not.toContain("Limited");
  });

  test("an app requesting nothing gets one muted line", () => {
    const html = render({ requested: [] });
    expect(html).toContain("No usage descriptions in Info.plist");
    expect(html).toContain("All permissions");
  });

  test("an unreadable Info.plist renders one flat list", () => {
    const html = render({ requested: null, statuses: { camera: "granted" } });
    expect(html).not.toContain("Requested by app");
    expect(html).not.toContain("All permissions");
    expect(html).not.toContain("No usage descriptions");
    expect(html.match(/data-permission=/g)).toHaveLength(17);
    expect(pressed(html, "camera")).toEqual(["Allow"]);
  });

  test("hides the second section when the app requests everything", () => {
    const html = render({ requested: PERMISSION_SERVICES.map((s) => s.key) });
    expect(html).toContain("Requested by app");
    expect(html).not.toContain("All permissions");
  });
});
