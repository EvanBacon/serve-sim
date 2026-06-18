import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppPermissionsLoading,
  AppPermissionsTool,
} from "../client/components/app-permissions-tool";

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
