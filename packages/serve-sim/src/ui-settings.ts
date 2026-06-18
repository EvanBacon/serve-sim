import { execFile } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { findBootedDevice, resolveDevice } from "./device";
import { dirnameOf } from "./runtime";

// Bun's bundler inlines a bare `__dirname` as the build machine's source
// directory; shadow it with the runtime location so the published bundle
// finds dist/simax next to itself (same pattern as index.ts).
const __dirname = dirnameOf(import.meta.url);

// ─── Option catalogue ───
//
// Simulator-wide options surfaced in the sidebar, mirroring the Xcode Devices
// app. Three (`appearance`, `increase-contrast`, `text-size`) ride on
// `simctl ui`; the rest have no simctl verb, so they go through the
// sim-ax-settings helper spawned inside the simulator (see
// Sources/SimAXSettings), which drives the same private libAccessibility /
// MediaAccessibility setters the Devices app uses.

export const CONTENT_SIZE_CATEGORIES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;

export const COLOR_FILTERS = [
  "none",
  "grayscale",
  "red-green",
  "green-red",
  "blue-yellow",
] as const;

const COLOR_FILTER_ALIASES: Record<string, string> = {
  protanopia: "red-green",
  deuteranopia: "green-red",
  tritanopia: "blue-yellow",
};

const TOGGLE_VALUES = ["on", "off"] as const;

const ON_SYNONYMS = new Set(["on", "true", "enabled", "1", "yes"]);
const OFF_SYNONYMS = new Set(["off", "false", "disabled", "0", "no"]);

interface UiOptionSpec {
  /** `simctl ui` subcommand, or "ax" for the in-sim helper. */
  via: "appearance" | "increase_contrast" | "content_size" | "ax";
  values: readonly string[];
  /** Extra accepted set-values that aren't reported by `get` (text-size). */
  extraValues?: readonly string[];
  aliases?: Record<string, string>;
  toggle?: boolean;
}

export const UI_OPTIONS: Record<string, UiOptionSpec> = {
  appearance: { via: "appearance", values: ["light", "dark"] },
  "liquid-glass": { via: "ax", values: ["clear", "tinted"] },
  "color-filter": { via: "ax", values: COLOR_FILTERS, aliases: COLOR_FILTER_ALIASES },
  "text-size": {
    via: "content_size",
    values: CONTENT_SIZE_CATEGORIES,
    extraValues: ["increment", "decrement"],
  },
  "reduce-motion": { via: "ax", values: TOGGLE_VALUES, toggle: true },
  "increase-contrast": { via: "increase_contrast", values: TOGGLE_VALUES, toggle: true },
  "show-borders": { via: "ax", values: TOGGLE_VALUES, toggle: true },
  "reduce-transparency": { via: "ax", values: TOGGLE_VALUES, toggle: true },
  voiceover: { via: "ax", values: TOGGLE_VALUES, toggle: true },
};

/**
 * Map a user-supplied value onto its canonical form for the option, or null
 * when the value isn't valid. Toggles accept the usual on/off synonyms.
 */
export function normalizeUiValue(option: string, value: string): string | null {
  const spec = UI_OPTIONS[option];
  if (!spec) return null;
  const v = value.toLowerCase();
  if (spec.toggle) {
    if (ON_SYNONYMS.has(v)) return "on";
    if (OFF_SYNONYMS.has(v)) return "off";
    return null;
  }
  const aliased = spec.aliases?.[v] ?? v;
  if (spec.values.includes(aliased)) return aliased;
  if (spec.extraValues?.includes(aliased)) return aliased;
  return null;
}

export interface UiArgs {
  command: "status" | "get" | "set";
  option?: string;
  value?: string;
  device?: string;
  json: boolean;
  error?: string;
}

export function parseUiArgs(args: string[]): UiArgs {
  const rest: string[] = [];
  let device: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-d" || a === "--device") {
      if (i + 1 >= args.length) {
        return { command: "get", json, error: `${a} requires a value` };
      }
      device = args[++i];
    } else if (a === "--json") json = true;
    else rest.push(a);
  }

  if (rest.length === 0 || rest[0] === "status") {
    return { command: "status", json, ...(device ? { device } : {}) };
  }

  const option = rest[0]!.toLowerCase();
  if (!UI_OPTIONS[option]) {
    return { command: "get", json, error: `unknown option: ${option}` };
  }
  if (rest.length === 1) {
    return { command: "get", option, json, ...(device ? { device } : {}) };
  }
  const value = normalizeUiValue(option, rest[1]!);
  if (value === null) {
    const spec = UI_OPTIONS[option]!;
    const accepted = [...spec.values, ...(spec.extraValues ?? [])].join("|");
    return {
      command: "set",
      option,
      json,
      error: `invalid value for ${option}: ${rest[1]} (accepted: ${accepted})`,
    };
  }
  return { command: "set", option, value, json, ...(device ? { device } : {}) };
}

// ─── In-sim helper binary ───

export function locateAxSettingsTool(): string | null {
  const candidates = [
    join(__dirname, "..", "dist", "simax", "serve-sim-ax-settings"),
    join(__dirname, "simax", "serve-sim-ax-settings"),
  ];
  for (const p of candidates) if (existsSync(p)) return resolve(p);
  return null;
}

// One-time build is memoized as a promise so concurrent in-server callers
// share a single clang invocation instead of racing.
let axToolPromise: Promise<string> | null = null;

function axSettingsTool(): Promise<string> {
  axToolPromise ??= (async () => {
    const located = locateAxSettingsTool();
    if (located) return located;
    const buildScript = join(__dirname, "..", "Sources", "SimAXSettings", "build.sh");
    if (!existsSync(buildScript)) {
      throw new Error(
        "sim-ax-settings binary not found — this build of serve-sim does not " +
          "include the simulator settings helper. Reinstall from a recent release.",
      );
    }
    console.error("[serve-sim] building sim-ax-settings (one-time)…");
    await run("bash", [buildScript]);
    const out = locateAxSettingsTool();
    if (!out) throw new Error("Build succeeded but sim-ax-settings not found.");
    return out;
  })();
  axToolPromise.catch(() => {
    axToolPromise = null;
  });
  return axToolPromise;
}

// ─── Backends ───
// Async throughout: these also run inside the preview server's event loop
// (the sidebar drives them through the control socket), where a blocking
// execFileSync would stall every stream the server is carrying.

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

function simctlUi(udid: string, subcommand: string, value?: string): Promise<string> {
  const args = ["simctl", "ui", udid, subcommand];
  if (value !== undefined) args.push(value);
  return run("xcrun", args);
}

async function axRun(udid: string, ...args: string[]): Promise<string> {
  const tool = await axSettingsTool();
  return run("xcrun", ["simctl", "spawn", udid, tool, ...args]);
}

function toToggle(simctlValue: string): string {
  return simctlValue === "enabled" ? "on" : "off";
}

function fromToggle(value: string): string {
  return value === "on" ? "enabled" : "disabled";
}

export async function getUiOption(udid: string, option: string): Promise<string> {
  const spec = UI_OPTIONS[option];
  if (!spec) throw new Error(`unknown option: ${option}`);
  if (spec.via === "ax") return axRun(udid, "get", option);
  // simctl's casing is inconsistent (`content_size` prints "Small" but
  // "large") — values are canonically lowercase everywhere here.
  const raw = (await simctlUi(udid, spec.via)).toLowerCase();
  return spec.toggle ? toToggle(raw) : raw;
}

export async function setUiOption(udid: string, option: string, value: string): Promise<void> {
  const spec = UI_OPTIONS[option];
  if (!spec) throw new Error(`unknown option: ${option}`);
  if (spec.via === "ax") {
    await axRun(udid, "set", option, value);
    return;
  }
  await simctlUi(udid, spec.via, spec.toggle ? fromToggle(value) : value);
}

export async function getUiStatus(udid: string): Promise<Record<string, string>> {
  // One ax-tool spawn covers all its settings; the simctl-backed reads fan
  // out in parallel alongside it. The ax helper is an iOS-simulator Mach-O, so
  // on watchOS / tvOS / visionOS the spawn aborts in dyld — degrade those
  // options to "unsupported" instead of failing the whole panel. (The web UI
  // also gates the panel on the device runtime, so this is the backstop for
  // direct callers.)
  const simctlOptions = Object.entries(UI_OPTIONS).filter(([, spec]) => spec.via !== "ax");
  const [axStatus, ...simctlValues] = await Promise.all([
    axRun(udid, "status")
      .then((out) => JSON.parse(out) as Record<string, string>)
      .catch(() => ({}) as Record<string, string>),
    ...simctlOptions.map(([option]) => getUiOption(udid, option).catch(() => "unsupported")),
  ]);
  const status: Record<string, string> = {};
  for (const [option, spec] of Object.entries(UI_OPTIONS)) {
    if (spec.via === "ax") status[option] = axStatus[option] ?? "unsupported";
  }
  simctlOptions.forEach(([option], i) => {
    status[option] = simctlValues[i]!;
  });
  return status;
}

// ─── CLI entry (`serve-sim ui …`) ───

const USAGE = `Usage: serve-sim ui [status] [--json] [-d udid]
       serve-sim ui <option> [-d udid]            Print the current value
       serve-sim ui <option> <value> [-d udid]    Change the value

Simulator-wide UI options:
  appearance           light | dark
  liquid-glass         clear | tinted
  color-filter         none | grayscale | red-green | green-red | blue-yellow
                       (protanopia/deuteranopia/tritanopia aliases accepted)
  text-size            ${CONTENT_SIZE_CATEGORIES.slice(0, 4).join(" | ")} | …
                       (12 content-size categories, or increment | decrement)
  reduce-motion        on | off
  increase-contrast    on | off
  show-borders         on | off
  reduce-transparency  on | off
  voiceover            on | off`;

export async function uiSettings(args: string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const parsed = parseUiArgs(args);
  if (parsed.error) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(1);
  }

  const udid = parsed.device ? resolveDevice(parsed.device) : findBootedDevice();
  if (!udid) {
    console.error("No booted simulator found. Boot one or pass -d <udid>.");
    process.exit(1);
  }

  if (parsed.command === "status") {
    const status = await getUiStatus(udid);
    if (parsed.json) {
      console.log(JSON.stringify(status));
    } else {
      for (const [option, value] of Object.entries(status)) {
        console.log(`${option.padEnd(20)} ${value}`);
      }
    }
    return;
  }

  if (parsed.command === "get") {
    console.log(await getUiOption(udid, parsed.option!));
    return;
  }

  await setUiOption(udid, parsed.option!, parsed.value!);
}
