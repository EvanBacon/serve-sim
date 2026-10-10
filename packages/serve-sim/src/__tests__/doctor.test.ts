import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import {
  buildDiagnosticsBundle,
  collectHostDiagnostics,
  diagnosticsVerdicts,
  formatDiagnosticsSummary,
  isLoopbackAddress,
  type Probe,
} from "../doctor";
import { isLoopbackRequest, simMiddleware } from "../middleware";

const HOME = "/Users/evan";

const probe: Probe = async (file, args) => {
  const key = [file, ...args].join(" ");
  const answers: Record<string, string> = {
    "/usr/bin/sw_vers -productVersion": "27.0",
    "/usr/bin/sw_vers -buildVersion": "27A100",
    "/usr/sbin/sysctl -n machdep.cpu.brand_string": "Apple M4 Max",
    "/usr/bin/xcode-select -p": "/Applications/Xcode.app/Contents/Developer",
    "/usr/bin/xcodebuild -version": "Xcode 27.0\nBuild version 27A5000",
    "/bin/ps -axo pid=,command=": [
      "  1 /sbin/launchd",
      "  812 /Users/evan/Downloads/Xcode-beta.app/Contents/Applications/DeviceHub.app/Contents/MacOS/DeviceHub --serve",
    ].join("\n"),
    "/usr/bin/defaults read /Applications/Xcode.app/Contents/Info CFBundleShortVersionString": "27.0",
    "/usr/bin/defaults read /Users/evan/Downloads/Xcode-beta.app/Contents/Info CFBundleShortVersionString": "27.1",
  };
  return answers[key] ?? null;
};

async function host() {
  return collectHostDiagnostics({
    probe,
    env: {},
    listXcodes: async () => ["/Applications/Xcode.app", `${HOME}/Downloads/Xcode-beta.app`],
    exists: (path) => path.startsWith(`${HOME}/Downloads/Xcode-beta.app`),
  });
}

describe("serve-sim doctor bundle", () => {
  test("has a stable shape: versions, Xcodes with Duo model, Device Hub owner, renderer lookup", async () => {
    const bundle = buildDiagnosticsBundle({ host: await host(), now: new Date("2026-10-10T18:00:00Z"), home: HOME });
    expect(Object.keys(bundle).sort()).toEqual(["devices", "event_log", "generated_at", "host", "schema_version", "serve_sim", "sessions"]);
    expect(bundle.schema_version).toBe(1);
    expect(bundle.generated_at).toBe("2026-10-10T18:00:00.000Z");
    expect(typeof bundle.serve_sim.version).toBe("string");
    expect(bundle.host).toMatchObject({
      macos: { version: "27.0", build: "27A100" },
      chip: "Apple M4 Max",
      xcode: {
        xcode_select: "/Applications/Xcode.app/Contents/Developer",
        developer_dir_env: null,
        xcodebuild_version: "Xcode 27.0\nBuild version 27A5000",
        installed: [
          { path: "/Applications/Xcode.app", version: "27.0", selected: true, has_duo_model: false, has_device_hub: false },
          { path: "~/Downloads/Xcode-beta.app", version: "27.1", selected: false, has_duo_model: true, has_device_hub: true },
        ],
      },
      device_hub: { processes: [{ pid: 812, xcode: "~/Downloads/Xcode-beta.app", matches_selected: false }] },
      duo_renderer: { model_source: "xcode-select", model_found: false },
    });
  });

  test("redacts every home path and never carries an exec token", async () => {
    const bundle = buildDiagnosticsBundle({
      host: await host(),
      sessions: [{ udid: "U", streams: { "3d": { open: 0, frames: 0, last_frame_at: null, last_error: { message: `missing ${HOME}/x`, stage: "model_lookup" } } } }],
      home: HOME,
    });
    const json = JSON.stringify(bundle);
    expect(json).not.toContain(HOME);
    expect(json).toContain("~/Downloads/Xcode-beta.app");
    expect(json.toLowerCase()).not.toContain("exectoken");
    expect(json.toLowerCase()).not.toContain("exec_token");
  });

  test("verdicts and summary call out a Device Hub from another Xcode and stream errors", async () => {
    const bundle = buildDiagnosticsBundle({
      host: await host(),
      sessions: [{
        udid: "DUO-UDID-1234",
        streams: { "3d": { open: 0, frames: 0, last_frame_at: null, last_error: { message: "No 3D frame within 11s", stage: "first_frame" } } },
        native: { encoders: { errors: [{ codec: "AVCC", error: "encodingFailed: kVTPixelTransferNotSupportedErr (-12905)", width: 2007, height: 2853, count: 3 }] } },
        duo: { renderer: "absent", hinge_degrees: null, active_panel: "inner", last_error: { stage: "first_frame", reason: "No 3D frame within 11s" } },
      }],
      home: HOME,
    });
    const verdicts = diagnosticsVerdicts(bundle);
    expect(verdicts[0]).toContain("Device Hub runs from ~/Downloads/Xcode-beta.app");
    expect(verdicts).toContain("Selected Xcode has no iPhone Duo 3D model (/Applications/Xcode.app/Contents/SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz).");
    expect(verdicts).toContain("3d stream for DUO-UDID: first_frame: No 3D frame within 11s");
    expect(verdicts).toContain("AVCC encoder: encodingFailed: kVTPixelTransferNotSupportedErr (-12905) at 2007x2853 (3x)");
    const summary = formatDiagnosticsSummary(bundle);
    expect(summary).toContain("xcode-select -p: /Applications/Xcode.app/Contents/Developer");
    expect(summary).toContain("duo renderer=absent hinge=unknown panel=inner");
  });
});

describe("/api/diagnostics loopback guard", () => {
  test("accepts only loopback peers without non-loopback forwarding hops", () => {
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.2"].every(isLoopbackAddress)).toBe(true);
    expect(["10.0.0.4", "::ffff:192.168.1.2", "", undefined].some(isLoopbackAddress)).toBe(false);
    const req = (remoteAddress: string, forwarded?: string) => ({ socket: { remoteAddress }, headers: forwarded ? { "x-forwarded-for": forwarded } : {} }) as never;
    expect(isLoopbackRequest(req("127.0.0.1"))).toBe(true);
    expect(isLoopbackRequest(req("127.0.0.1", "203.0.113.9"))).toBe(false);
    expect(isLoopbackRequest(req("192.168.1.5"))).toBe(false);
  });

  test("the endpoint serves JSON on loopback and refuses forwarded requests", async () => {
    const middleware = simMiddleware({ basePath: "/" });
    const server: Server = createServer((req, res) => { void middleware(req, res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/diagnostics`;
    try {
      const ok = await fetch(url);
      expect(ok.status).toBe(200);
      const body = await ok.json() as Record<string, unknown>;
      expect(body.schema_version).toBe(1);
      expect(JSON.stringify(body)).not.toMatch(/exec_?token/i);
      const denied = await fetch(url, { headers: { "x-forwarded-for": "203.0.113.9" } });
      expect(denied.status).toBe(403);
      expect((await denied.json() as { error: string }).error).toBe("loopback_only");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
