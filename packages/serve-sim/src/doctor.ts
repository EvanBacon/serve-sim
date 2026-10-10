/**
 * `serve-sim doctor` and `/api/diagnostics`: one redacted JSON bundle with
 * everything needed to diagnose a stream failure from the field (#162).
 * Host probes are best-effort shell reads with short timeouts; nothing here
 * mutates the simulator, Xcode selection, or Device Hub.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { duoModelPath, resolveDuoModel, resolveDuoRendererExecutable } from "./duo-renderer";
import { readDeviceHubInputShadowed } from "./device-hub-input";
import { redactHome } from "./diagnostics-redact";

const DIAGNOSTICS_SCHEMA_VERSION = 1;

/** Run a command; resolve trimmed stdout, or null on any failure. Never throws. */
export type Probe = (file: string, args: string[]) => Promise<string | null>;

const defaultProbe: Probe = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    resolve(error ? null : String(stdout).trim());
  });
});

declare const __SERVE_SIM_VERSION__: string | undefined;
function serveSimVersion(): string {
  if (typeof __SERVE_SIM_VERSION__ === "string") return __SERVE_SIM_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type HostDiagnosticsOptions = {
  probe?: Probe;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  /** Candidate Xcode.app bundles; defaults to Spotlight plus /Applications. */
  listXcodes?: () => Promise<string[]>;
};

function xcodeAppFromDeveloperDir(developerDir: string): string | null {
  const match = /^(.*?\.app)\/Contents\/Developer\/?$/.exec(developerDir);
  return match ? match[1]! : null;
}

async function defaultListXcodes(probe: Probe): Promise<string[]> {
  const found = new Set<string>();
  const spotlight = await probe("/usr/bin/mdfind", ["kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"]);
  for (const line of spotlight?.split("\n") ?? []) if (line.trim().endsWith(".app")) found.add(line.trim());
  try {
    for (const name of readdirSync("/Applications")) {
      if (/^Xcode.*\.app$/.test(name)) found.add(join("/Applications", name));
    }
  } catch { /* not macOS */ }
  return [...found].sort();
}

/** Host facts: OS, chip, Xcode selection, installed Xcodes, Device Hub processes. */
export async function collectHostDiagnostics(options: HostDiagnosticsOptions = {}): Promise<Record<string, unknown>> {
  const probe = options.probe ?? defaultProbe;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const [macos, macosBuild, chip, selected, xcodebuild, ps] = await Promise.all([
    probe("/usr/bin/sw_vers", ["-productVersion"]),
    probe("/usr/bin/sw_vers", ["-buildVersion"]),
    probe("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
    probe("/usr/bin/xcode-select", ["-p"]),
    probe("/usr/bin/xcodebuild", ["-version"]),
    probe("/bin/ps", ["-axo", "pid=,command="]),
  ]);
  const developerDir = env.DEVELOPER_DIR ?? selected;
  const selectedApp = developerDir ? xcodeAppFromDeveloperDir(developerDir) : null;

  const apps = await (options.listXcodes ? options.listXcodes() : defaultListXcodes(probe));
  const xcodes = await Promise.all(apps.map(async (app) => {
    const version = await probe("/usr/bin/defaults", ["read", join(app, "Contents", "Info"), "CFBundleShortVersionString"]);
    const build = await probe("/usr/bin/defaults", ["read", join(app, "Contents", "version"), "ProductBuildVersion"]);
    return {
      path: app,
      version,
      build,
      selected: app === selectedApp,
      has_device_hub: exists(join(app, "Contents", "Applications", "DeviceHub.app")),
      has_duo_model: exists(duoModelPath(join(app, "Contents", "Developer"))),
    };
  }));

  const deviceHubs = (ps ?? "").split("\n")
    .map((line) => /^\s*(\d+)\s+(.*\/DeviceHub\.app\/Contents\/MacOS\/\S+)/.exec(line))
    .filter((match): match is RegExpExecArray => match != null)
    .map((match) => {
      const executable = match[2]!;
      const xcode = /^(.*?\.app)\/Contents\/Applications\/DeviceHub\.app\//.exec(executable)?.[1] ?? null;
      return { pid: Number(match[1]), executable, xcode, matches_selected: xcode != null && xcode === selectedApp };
    });

  const model = resolveDuoModel(env, () => {
    if (!selected) throw new Error("xcode-select -p failed");
    return selected;
  }, exists);

  return {
    macos: { version: macos, build: macosBuild },
    chip,
    arch: process.arch,
    node: process.version,
    xcode: {
      xcode_select: selected,
      developer_dir_env: env.DEVELOPER_DIR ?? null,
      effective_developer_dir: developerDir,
      xcodebuild_version: xcodebuild,
      installed: xcodes,
    },
    device_hub: { processes: deviceHubs },
    duo_renderer: {
      executable: resolveDuoRendererExecutable(),
      model_path: model.modelPath,
      model_source: model.source,
      model_found: model.exists,
      ...(model.error ? { model_error: model.error } : {}),
    },
  };
}

/** Simulator facts for one UDID from `simctl list -j`, plus the guest Device Hub input flag. */
export async function collectDeviceDiagnostics(udid: string, probe: Probe = defaultProbe): Promise<Record<string, unknown>> {
  const listing = await probe("/usr/bin/xcrun", ["simctl", "list", "devices", "-j"]);
  let device: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(listing ?? "{}") as { devices?: Record<string, Array<Record<string, unknown>>> };
    for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
      const found = devices.find((entry) => entry.udid === udid);
      if (found) {
        device = { name: found.name, state: found.state, runtime, device_type: found.deviceTypeIdentifier ?? null };
        break;
      }
    }
  } catch { /* leave null */ }
  return {
    udid,
    ...(device ?? { error: "not found in simctl list" }),
    device_hub_input_shadowed: await readDeviceHubInputShadowed(udid, async (args) => {
      const output = await probe("/usr/bin/xcrun", args);
      if (output == null) throw new Error("probe failed");
      return output;
    }),
  };
}

export type DiagnosticsBundle = {
  schema_version: number;
  generated_at: string;
  serve_sim: { version: string; pid: number };
  host: Record<string, unknown>;
  devices: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  event_log: unknown[];
  server?: { reachable: boolean; url?: string; error?: string };
};

/** Assemble and redact. Callers must never pass the exec token or raw preview config in. */
export function buildDiagnosticsBundle(parts: {
  host: Record<string, unknown>;
  devices?: Record<string, unknown>[];
  sessions?: Record<string, unknown>[];
  event_log?: unknown[];
  server?: DiagnosticsBundle["server"];
  now?: Date;
  home?: string;
}): DiagnosticsBundle {
  const bundle: DiagnosticsBundle = {
    schema_version: DIAGNOSTICS_SCHEMA_VERSION,
    generated_at: (parts.now ?? new Date()).toISOString(),
    serve_sim: { version: serveSimVersion(), pid: process.pid },
    host: parts.host,
    devices: parts.devices ?? [],
    sessions: parts.sessions ?? [],
    event_log: parts.event_log ?? [],
    ...(parts.server ? { server: parts.server } : {}),
  };
  return redactHome(bundle, parts.home);
}

/** One-line verdicts for the human summary, most actionable first. */
export function diagnosticsVerdicts(bundle: DiagnosticsBundle): string[] {
  const out: string[] = [];
  const host = bundle.host as {
    duo_renderer?: { model_found?: boolean; model_path?: string | null };
    device_hub?: { processes?: Array<{ xcode: string | null; matches_selected: boolean }> };
    xcode?: { effective_developer_dir?: string | null };
  };
  const hubs = host.device_hub?.processes ?? [];
  if (hubs.some((hub) => !hub.matches_selected)) {
    out.push(`Device Hub runs from ${hubs.map((hub) => hub.xcode ?? "?").join(", ")}, not the selected Xcode (${host.xcode?.effective_developer_dir ?? "unknown"}).`);
  }
  const duoSessions = bundle.sessions.filter((session) => (session.duo as { renderer?: string } | undefined) != null);
  if (host.duo_renderer?.model_found === false && duoSessions.length > 0) {
    out.push(`Selected Xcode has no iPhone Duo 3D model (${host.duo_renderer.model_path ?? "no path"}).`);
  }
  for (const session of bundle.sessions) {
    const streams = session.streams as Record<string, { last_error: { message: string; stage?: string } | null }> | undefined;
    for (const [endpoint, health] of Object.entries(streams ?? {})) {
      if (health.last_error) out.push(`${endpoint} stream for ${String(session.udid).slice(0, 8)}: ${health.last_error.stage ? `${health.last_error.stage}: ` : ""}${health.last_error.message}`);
    }
    const errors = ((session.native as { encoders?: { errors?: Array<{ codec: string; error: string; width: number; height: number; count: number }> } } | undefined)?.encoders?.errors) ?? [];
    for (const error of errors) out.push(`${error.codec} encoder: ${error.error} at ${error.width}x${error.height} (${error.count}x)`);
  }
  return out;
}

/** True only for loopback peers. `/api/diagnostics` exposes host paths and process lists. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address === "::ffff:127.0.0.1" || address.startsWith("::ffff:127.");
}

/** Human summary for `serve-sim doctor` without --json. */
export function formatDiagnosticsSummary(bundle: DiagnosticsBundle): string {
  const host = bundle.host as {
    macos?: { version: string | null };
    chip?: string | null;
    arch?: string;
    xcode?: { xcode_select: string | null; developer_dir_env: string | null; xcodebuild_version: string | null; installed: Array<{ path: string; version: string | null; selected: boolean; has_duo_model: boolean }> };
    device_hub?: { processes: Array<{ executable: string; matches_selected: boolean }> };
    duo_renderer?: { model_path: string | null; model_found: boolean };
  };
  const lines = [
    `serve-sim ${bundle.serve_sim.version}  macOS ${host.macos?.version ?? "?"}  ${host.chip ?? host.arch ?? ""}`.trim(),
    `xcode-select -p: ${host.xcode?.xcode_select ?? "(failed)"}${host.xcode?.developer_dir_env ? `  DEVELOPER_DIR=${host.xcode.developer_dir_env}` : ""}`,
    `xcodebuild: ${(host.xcode?.xcodebuild_version ?? "(failed)").replace(/\n/g, " ")}`,
    "Xcodes:",
    ...(host.xcode?.installed ?? []).map((xcode) => `  ${xcode.selected ? "*" : " "} ${xcode.path} ${xcode.version ?? ""}  Duo model: ${xcode.has_duo_model ? "yes" : "no"}`),
    `Device Hub: ${(host.device_hub?.processes ?? []).map((hub) => `${hub.executable}${hub.matches_selected ? "" : " (not selected Xcode)"}`).join(", ") || "not running"}`,
    `Duo model: ${host.duo_renderer?.model_found ? "found" : "missing"} at ${host.duo_renderer?.model_path ?? "?"}`,
  ];
  for (const session of bundle.sessions) {
    const streams = session.streams as Record<string, { open: number; frames: number; last_frame_at: string | null; last_error: { message: string } | null }>;
    lines.push(`Session ${session.udid}:`);
    for (const [endpoint, health] of Object.entries(streams ?? {})) {
      lines.push(`  ${endpoint.padEnd(5)} open=${health.open} frames=${health.frames} last=${health.last_frame_at ?? "-"}${health.last_error ? ` error=${health.last_error.message}` : ""}`);
    }
    const capture = (session.native as { capture?: { native_displays?: Array<{ width: number; height: number }>; captured?: { width: number; height: number }; selection_reason?: string } } | null)?.capture;
    if (capture) {
      lines.push(`  displays ${(capture.native_displays ?? []).map((size) => `${size.width}x${size.height}`).join(", ")}; capturing ${capture.captured?.width}x${capture.captured?.height} (${capture.selection_reason})`);
    }
    const duo = session.duo as { renderer?: string; hinge_degrees?: number | null; active_panel?: string; last_error?: { stage: string; reason: string } | null } | undefined;
    if (duo) lines.push(`  duo renderer=${duo.renderer} hinge=${duo.hinge_degrees ?? "unknown"} panel=${duo.active_panel}${duo.last_error ? ` last_error=${duo.last_error.stage}: ${duo.last_error.reason}` : ""}`);
  }
  if (bundle.server && !bundle.server.reachable) lines.push(`Server: not reachable (${bundle.server.error ?? "not running"}); live stream state omitted.`);
  const verdicts = diagnosticsVerdicts(bundle);
  if (verdicts.length) lines.push("Findings:", ...verdicts.map((verdict) => `  - ${verdict}`));
  return lines.join("\n");
}
