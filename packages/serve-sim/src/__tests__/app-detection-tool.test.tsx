import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppIconFallback, isSystemBundleId } from "../client/components/app-detection-tool";

describe("AppDetectionTool app icon fallback", () => {
  test("recognizes Apple system bundle ids", () => {
    expect(isSystemBundleId("com.apple.springboard")).toBe(true);
    expect(isSystemBundleId("com.example.app")).toBe(false);
  });

  test("renders a system-app treatment instead of an empty square", () => {
    const html = renderToStaticMarkup(<AppIconFallback bundleId="com.apple.springboard" />);

    expect(html).toContain('data-testid="system-app-icon"');
    expect(html).toContain("System app");
    expect(html).toContain('role="img"');
    expect(html).toContain("<title>Apple</title>");
    expect(html).toContain("M12.152 6.896c-.948");
  });
});
