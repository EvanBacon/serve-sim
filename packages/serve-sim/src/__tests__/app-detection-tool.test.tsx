import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppDetectionSkeleton,
  AppIconFallback,
  AppSummaryLabel,
  isSystemBundleId,
} from "../client/components/app-detection-tool";

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

describe("AppSummaryLabel", () => {
  test("keeps pending text left-aligned and reserves the loading slot", () => {
    const html = renderToStaticMarkup(
      <AppSummaryLabel
        bundleId="com.apple.springboard"
        displayName="SpringBoard"
        loading
      />,
    );

    expect(html).toContain("text-left");
    expect(html).toContain('data-testid="app-summary-loading"');
    expect(html).toContain("SpringBoard");
    expect(html).not.toContain("SpringBoard …");
  });
});

describe("AppDetectionSkeleton", () => {
  test("uses the app summary footprint without dashed waiting text", () => {
    const html = renderToStaticMarkup(<AppDetectionSkeleton />);

    expect(html).toContain('data-testid="app-detection-skeleton"');
    expect(html).toContain("bg-panel rounded-[10px] px-3 py-2");
    expect(html).toContain("min-h-[36px]");
    expect(html).not.toContain("border-dashed");
    expect(html).not.toContain("Waiting for an app");
  });
});
