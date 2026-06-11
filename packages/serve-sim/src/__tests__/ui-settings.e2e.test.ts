import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

// Drives the built CLI's `ui` verb against whatever simulator is already
// booted (the CI `sim-test.yml` job boots one before running this directory).
// Each assertion reads the underlying preference store the simulator actually
// consults — com.apple.Accessibility, com.apple.mediaaccessibility,
// com.apple.UIKit — or `simctl ui` for the options it natively reports,
// rather than trusting the value the CLI itself echoes back.

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");

function bootedUdid(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!/iOS/i.test(runtime)) continue;
      for (const d of devices) if (d.state === "Booted") return d.udid;
    }
  } catch {}
  return null;
}

const udid = bootedUdid();

// `simctl ui` hangs *intermittently per-call* on GitHub's shared macOS
// runners — a probe can succeed and the very next call hang for minutes
// (the same unwarmed-UI-plane breakage the avcc and ax suites skip around),
// so no point-in-time health check can gate this reliably. Skip on CI by
// default; SERVE_SIM_UI_E2E=1 forces the suite on for runners where the
// simulator UI plane actually works. Off-CI, a bounded probe still guards
// against a wedged local sim.
const skipOnCi = !!process.env.CI && process.env.SERVE_SIM_UI_E2E !== "1";

function simctlUiUsable(): boolean {
  if (!udid) return false;
  if (skipOnCi) {
    console.warn("[ui-settings.e2e] skipping on CI: `simctl ui` hangs intermittently on shared runners (set SERVE_SIM_UI_E2E=1 to force)");
    return false;
  }
  try {
    execFileSync("xcrun", ["simctl", "ui", udid, "appearance"], {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    console.warn("[ui-settings.e2e] skipping: `simctl ui` is not functional on this host");
    return false;
  }
}

const describeIfSim = udid && existsSync(CLI) && simctlUiUsable() ? describe : describe.skip;

// Timeouts on every child call so a wedged simulator fails the test instead
// of hanging the CI job.
const EXEC_TIMEOUT_MS = 15_000;

function cli(...args: string[]): string {
  return execFileSync("node", [CLI, "ui", ...args, "-d", udid!], {
    encoding: "utf-8",
    timeout: EXEC_TIMEOUT_MS,
  }).trim();
}

function simDefault(domain: string, key: string): string {
  try {
    return execFileSync(
      "xcrun",
      ["simctl", "spawn", udid!, "defaults", "read", domain, key],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: EXEC_TIMEOUT_MS },
    ).trim();
  } catch {
    return "<missing>";
  }
}

function simctlUi(subcommand: string): string {
  return execFileSync("xcrun", ["simctl", "ui", udid!, subcommand], {
    encoding: "utf-8",
    timeout: EXEC_TIMEOUT_MS,
  }).trim();
}

describeIfSim("serve-sim ui (simulator-wide options)", () => {
  afterAll(() => {
    // Leave the simulator in stock state for whatever runs next.
    for (const [option, value] of [
      ["appearance", "light"],
      ["liquid-glass", "clear"],
      ["color-filter", "none"],
      ["text-size", "large"],
      ["reduce-motion", "off"],
      ["increase-contrast", "off"],
      ["show-borders", "off"],
      ["reduce-transparency", "off"],
      ["voiceover", "off"],
    ] as const) {
      try {
        cli(option, value);
      } catch {}
    }
  });

  test("appearance switches dark and back", () => {
    cli("appearance", "dark");
    expect(simctlUi("appearance")).toBe("dark");
    cli("appearance", "light");
    expect(simctlUi("appearance")).toBe("light");
  });

  test("liquid glass writes the UIKit legibility preference", () => {
    cli("liquid-glass", "tinted");
    expect(simDefault("com.apple.UIKit", "UIViewGlassLegibilitySetting")).toBe("1");
    expect(cli("liquid-glass")).toBe("tinted");
    cli("liquid-glass", "clear");
    expect(simDefault("com.apple.UIKit", "UIViewGlassLegibilitySetting")).toBe("0");
  });

  test("color filters set the media-accessibility display filter", () => {
    const cases = [
      ["grayscale", "1"],
      ["red-green", "2"],
      ["green-red", "4"],
      ["blue-yellow", "8"],
    ] as const;
    for (const [name, type] of cases) {
      cli("color-filter", name);
      expect(
        simDefault("com.apple.mediaaccessibility", "__Color__.MADisplayFilterCategoryEnabled"),
      ).toBe("1");
      expect(
        simDefault("com.apple.mediaaccessibility", "__Color__.MADisplayFilterType"),
      ).toBe(type);
      expect(cli("color-filter")).toBe(name);
    }
    // Grayscale additionally mirrors into the Accessibility domain.
    cli("color-filter", "grayscale");
    expect(simDefault("com.apple.Accessibility", "GrayscaleDisplay")).toBe("1");
    cli("color-filter", "none");
    expect(
      simDefault("com.apple.mediaaccessibility", "__Color__.MADisplayFilterCategoryEnabled"),
    ).toBe("0");
    expect(simDefault("com.apple.Accessibility", "GrayscaleDisplay")).toBe("0");
  }, 30_000);

  test("text size sets the content size category", () => {
    cli("text-size", "accessibility-medium");
    expect(simctlUi("content_size")).toBe("accessibility-medium");
    cli("text-size", "large");
    expect(simctlUi("content_size")).toBe("large");
  });

  test("increase contrast toggles through simctl ui", () => {
    cli("increase-contrast", "on");
    expect(simctlUi("increase_contrast")).toBe("enabled");
    cli("increase-contrast", "off");
    expect(simctlUi("increase_contrast")).toBe("disabled");
  });

  test.each([
    ["reduce-motion", "ReduceMotionEnabled"],
    ["show-borders", "ButtonShapesEnabled"],
    ["reduce-transparency", "EnhancedBackgroundContrastEnabled"],
    ["voiceover", "VoiceOverTouchEnabled"],
  ] as const)("%s writes %s in com.apple.Accessibility", (option, key) => {
    cli(option, "on");
    expect(simDefault("com.apple.Accessibility", key)).toBe("1");
    expect(cli(option)).toBe("on");
    cli(option, "off");
    expect(simDefault("com.apple.Accessibility", key)).toBe("0");
    expect(cli(option)).toBe("off");
  }, 15_000);

  test("status reports every option as json", () => {
    const status = JSON.parse(cli("status", "--json")) as Record<string, string>;
    expect(Object.keys(status).sort()).toEqual([
      "appearance",
      "color-filter",
      "increase-contrast",
      "liquid-glass",
      "reduce-motion",
      "reduce-transparency",
      "show-borders",
      "text-size",
      "voiceover",
    ]);
  });
});
