import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import {
  buildDiagnosticsBundle,
  collectHostDiagnostics,
  diagnosticsVerdicts,
  findSimulatorCrashReports,
  formatDiagnosticsSummary,
  type Probe,
} from "../doctor";
import { simMiddleware } from "../middleware";
import { isTrustedLoopback } from "../request-trust";

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
  test("uses the shared socket-only trust check (any forwarding hop is untrusted)", () => {
    const req = (remoteAddress: string, forwarded?: string) => ({
      socket: { remoteAddress },
      headers: { host: "localhost:3200", ...(forwarded ? { "x-forwarded-for": forwarded } : {}) },
    }) as never;
    expect(isTrustedLoopback(req("127.0.0.1"))).toBe(true);
    expect(isTrustedLoopback(req("::1"))).toBe(true);
    expect(isTrustedLoopback(req("127.0.0.1", "127.0.0.1"))).toBe(false);
    expect(isTrustedLoopback(req("127.0.0.1", "203.0.113.9"))).toBe(false);
    expect(isTrustedLoopback(req("192.168.1.5"))).toBe(false);
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
      expect(JSON.stringify(await denied.json())).not.toContain("schema_version");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("simulator crash report pointer", () => {
  const UDID = "A1B2C3D4-0000-4000-8000-00000000ABCD";
  const header = (name: string) => JSON.stringify({ app_name: name, bug_type: "309" });

  test("lists recent .ips reports from simulator processes, newest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-ips-"));
    const now = Date.parse("2026-10-14T12:00:00Z");
    const write = (file: string, body: string, ageHours: number) => {
      const path = join(dir, file);
      writeFileSync(path, body);
      const t = new Date(now - ageHours * 3600_000);
      utimesSync(path, t, t);
    };
    write("MyApp-2026-10-14-110000.ips", `${header("MyApp")}\n{"procPath":"/Users/evan/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Bundle/Application/X/MyApp.app/MyApp"}`, 1);
    write("SpringBoard-2026-10-14-090000.ips", `${header("SpringBoard")}\n{"procPath":"\\/Library\\/Developer\\/CoreSimulator\\/Volumes\\/x\\/iOS 27.0.simruntime\\/Contents/Resources/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard"}`, 3);
    write("maild-2026-10-14-080000.ips", `{"app_name":"maild","platform":7,"bug_type":"309"}\n{"procPath" : "\\/Volumes\\/VOLUME\\/*\\/EmailDaemon.framework\\/maild"}`, 4);
    write("Safari-2026-10-14-100000.ips", `{"app_name":"Safari","platform":1}\n{"procPath":"/Applications/Safari.app/Contents/MacOS/Safari"}`, 2);
    write("Old-2026-09-01-100000.ips", `${header("Old")}\n{"procPath":"/x/CoreSimulator/Devices/${UDID}/data/Old"}`, 24 * 30);
    write("notes.txt", "CoreSimulator/Devices/", 1);

    const reports = findSimulatorCrashReports({ dir, now: () => now });
    expect(reports.directory).toBe(dir);
    expect(reports.recent.map((r) => r.file)).toEqual(["MyApp-2026-10-14-110000.ips", "SpringBoard-2026-10-14-090000.ips", "maild-2026-10-14-080000.ips"]);
    expect(reports.recent[0]!.path).toBe(join(dir, "MyApp-2026-10-14-110000.ips"));
    expect(reports.recent[0]!.udid).toBe(UDID);
    expect(reports.recent[0]!.process).toBe("MyApp");
  });

  test("a missing directory yields the pointer with no reports", () => {
    const reports = findSimulatorCrashReports({ dir: join(tmpdir(), "serve-sim-no-such-dir") });
    expect(reports.recent).toEqual([]);
  });

  test("the doctor summary always points at DiagnosticReports", () => {
    const bundle = buildDiagnosticsBundle({ host: {}, home: HOME });
    const none = formatDiagnosticsSummary({ ...bundle, crash_reports: { directory: "~/Library/Logs/DiagnosticReports", recent: [] } });
    expect(none).toContain("Simulator crash reports (.ips): ~/Library/Logs/DiagnosticReports");
    expect(none).toContain("none in the last 7 days");
    const some = formatDiagnosticsSummary({
      ...bundle,
      crash_reports: {
        directory: "~/Library/Logs/DiagnosticReports",
        recent: [{ file: "MyApp-1.ips", path: "~/Library/Logs/DiagnosticReports/MyApp-1.ips", modified_at: "2026-10-14T11:00:00.000Z", process: "MyApp", udid: UDID }],
      },
    });
    expect(some).toContain("~/Library/Logs/DiagnosticReports/MyApp-1.ips");
    expect(some).toContain("MyApp");
  });
});
