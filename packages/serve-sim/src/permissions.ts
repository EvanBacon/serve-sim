import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { findBootedDevice, resolveDevice } from "./device";

// ─── Permission catalogue ───

type PermissionKind = "tcc" | "notifications" | "location";

interface PermissionSpec {
  kind: PermissionKind;
  /** TCC service identifier, for `kind === "tcc"`. */
  tccService?: string;
  /** TCC `auth_version` column — photos uses 2, everything else 1. */
  tccAuthVersion?: number;
  /** Whether `--value` is meaningful for this permission. */
  values?: string[];
}

const TCC_SERVICES: Record<string, string> = {
  camera: "kTCCServiceCamera",
  microphone: "kTCCServiceMicrophone",
  photos: "kTCCServicePhotos",
  "photos-add": "kTCCServicePhotosAdd",
  contacts: "kTCCServiceAddressBook",
  calendar: "kTCCServiceCalendar",
  reminders: "kTCCServiceReminders",
  motion: "kTCCServiceMotion",
  "media-library": "kTCCServiceMediaLibrary",
  siri: "kTCCServiceSiri",
  speech: "kTCCServiceSpeechRecognition",
  faceid: "kTCCServiceFaceID",
  "user-tracking": "kTCCServiceUserTracking",
  homekit: "kTCCServiceWillow",
};

// Names that map onto a canonical permission, sometimes pinning a `--value`.
const ALIASES: Record<string, { permission: string; value?: string }> = {
  push: { permission: "notifications" },
  notification: { permission: "notifications" },
  "photo-library": { permission: "photos" },
  photo: { permission: "photos" },
  "location-always": { permission: "location", value: "always" },
  "location-in-use": { permission: "location", value: "inuse" },
  "location-inuse": { permission: "location", value: "inuse" },
  mic: { permission: "microphone" },
};

export function resolvePermission(name: string): PermissionSpec | null {
  if (name === "notifications") return { kind: "notifications", values: ["critical"] };
  if (name === "location")
    return { kind: "location", values: ["always", "inuse", "never"] };
  const service = TCC_SERVICES[name];
  if (service) {
    return {
      kind: "tcc",
      tccService: service,
      tccAuthVersion: name === "photos" ? 2 : 1,
      values: name === "photos" ? ["limited"] : undefined,
    };
  }
  return null;
}

/** Every canonical permission name, used by `reset all` and `--help`. */
export function allPermissionNames(): string[] {
  return ["notifications", "location", ...Object.keys(TCC_SERVICES)];
}

// ─── Argument parsing ───

export type Verb = "grant" | "revoke" | "reset" | "list";

export interface ParsedArgs {
  verb: Verb;
  /** Canonical permission name, or "all" for `reset all`. Absent for `list`. */
  permission?: string;
  value?: string;
  bundleId?: string;
  device?: string;
}

const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export function parsePermissionsArgs(
  args: string[],
): ParsedArgs | { error: string } {
  let device: string | undefined;
  let value: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "-d" || a === "--device") {
      device = args[++i];
      if (!device) return { error: "Missing value for -d/--device" };
    } else if (a === "--value") {
      value = args[++i];
      if (value === undefined) return { error: "Missing value for --value" };
    } else if (a.startsWith("--value=")) {
      value = a.slice("--value=".length);
    } else if (a.startsWith("-")) {
      return { error: `Unknown flag: ${a}` };
    } else {
      positional.push(a);
    }
  }

  const verbRaw = positional[0];
  if (!verbRaw) return { error: "Missing subcommand: grant | revoke | reset | list" };
  const verb: Verb | undefined = (
    { grant: "grant", revoke: "revoke", deny: "revoke", reset: "reset", list: "list" } as const
  )[verbRaw];
  if (!verb) return { error: `Unknown subcommand: ${verbRaw}` };

  if (verb === "list") {
    // permissions list [bundle-id] [-d udid]
    const bundleId = positional[1];
    if (bundleId && !BUNDLE_ID_RE.test(bundleId)) {
      return { error: `Invalid bundle id: ${bundleId}` };
    }
    return { verb, bundleId, device };
  }

  let permission = positional[1];
  if (!permission) return { error: `Missing permission name for "${verb}"` };

  // `reset all` is a special case — no bundle-scoped permission lookup.
  if (verb === "reset" && permission === "all") {
    const bundleId = positional[2];
    if (!bundleId) return { error: "Missing bundle id for `reset all`" };
    if (!BUNDLE_ID_RE.test(bundleId)) return { error: `Invalid bundle id: ${bundleId}` };
    return { verb, permission: "all", bundleId, device };
  }

  // Resolve aliases (may pin a value).
  const alias = ALIASES[permission];
  if (alias) {
    permission = alias.permission;
    if (alias.value && !value) value = alias.value;
  }

  const spec = resolvePermission(permission);
  if (!spec) {
    return {
      error: `Unknown permission: ${positional[1]}\nSupported: ${allPermissionNames().join(", ")}`,
    };
  }

  const bundleId = positional[2];
  if (!bundleId) return { error: `Missing bundle id for "${verb} ${permission}"` };
  if (!BUNDLE_ID_RE.test(bundleId)) return { error: `Invalid bundle id: ${bundleId}` };

  // A trailing positional (4th arg) is also accepted as the value, matching
  // applesimutils' `permission grant photos limited` shape.
  if (!value && positional[3]) value = positional[3];

  if (value !== undefined) {
    if (!spec.values || !spec.values.includes(value)) {
      const allowed = spec.values ? spec.values.join(", ") : "(none)";
      return {
        error: `Invalid --value "${value}" for ${permission}. Allowed: ${allowed}`,
      };
    }
  }

  return { verb, permission, value, bundleId, device };
}

// ─── Simulator paths ───

function simLibraryDir(udid: string): string {
  return join(
    homedir(),
    "Library/Developer/CoreSimulator/Devices",
    udid,
    "data/Library",
  );
}

export function tccDbPath(udid: string): string {
  return join(simLibraryDir(udid), "TCC/TCC.db");
}

export function bulletinDir(udid: string): string {
  return join(simLibraryDir(udid), "BulletinBoard");
}

export function locationdPlistPath(udid: string): string {
  return join(simLibraryDir(udid), "Caches/locationd/clients.plist");
}

// ─── TCC.db writer ───

function withSqliteRetry<T>(fn: () => T): T {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return fn();
    } catch (e: any) {
      const msg = String(e?.stderr ?? e?.message ?? e);
      if (Date.now() < deadline && /database is locked|database is busy/i.test(msg)) {
        // Boot race — CoreSimulator briefly holds TCC.db. Retry.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        continue;
      }
      throw e;
    }
  }
}

function sqlite(dbPath: string, sql: string): string {
  return withSqliteRetry(() =>
    execFileSync("sqlite3", [dbPath, sql], { encoding: "utf-8" }),
  );
}

function writeTcc(
  udid: string,
  service: string,
  authVersion: number,
  bundleId: string,
  authValue: number | "delete",
): void {
  const db = tccDbPath(udid);
  if (!existsSync(db)) {
    throw new Error(
      `TCC.db not found for ${udid}. Is the simulator booted?\n  ${db}`,
    );
  }
  // `service` comes from our fixed catalogue and `bundleId` is regex-validated
  // by the parser, so direct interpolation here cannot inject SQL.
  sqlite(
    db,
    `DELETE FROM access WHERE service='${service}' AND client='${bundleId}' AND client_type=0;`,
  );
  if (authValue !== "delete") {
    sqlite(
      db,
      `INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags) ` +
        `VALUES ('${service}', '${bundleId}', 0, ${authValue}, 2, ${authVersion}, 0);`,
    );
  }
}

// Reverse of TCC_SERVICES, so `list` reports the same permission names that
// grant/revoke/reset accept rather than raw kTCCService* database keys.
const TCC_NAME_BY_SERVICE: Record<string, string> = Object.fromEntries(
  Object.entries(TCC_SERVICES).map(([name, service]) => [service, name]),
);

function readTcc(udid: string, bundleId?: string): Record<string, number> {
  const db = tccDbPath(udid);
  if (!existsSync(db)) return {};
  const where = bundleId ? ` WHERE client='${bundleId}'` : "";
  const out = sqlite(
    db,
    `SELECT service, auth_value FROM access${where};`,
  );
  const result: Record<string, number> = {};
  for (const line of out.split("\n")) {
    const [service, authValue] = line.split("|");
    if (service) result[TCC_NAME_BY_SERVICE[service] ?? service] = Number(authValue);
  }
  return result;
}

// ─── plist helpers ───

function plutil(args: string[]): string {
  return execFileSync("plutil", args, { encoding: "utf-8" });
}

/**
 * Run PlistBuddy commands against a plist. PlistBuddy uses `:` as its key-path
 * separator, so dotted bundle ids work as literal key components — unlike
 * `plutil`, whose `.`-separated key paths can't address them and whose array
 * indices insert rather than replace.
 */
function plistBuddy(
  file: string,
  commands: string[],
  opts: { ignoreErrors?: boolean } = {},
): string {
  const args: string[] = [];
  for (const c of commands) args.push("-c", c);
  args.push(file);
  try {
    return execFileSync("/usr/libexec/PlistBuddy", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    if (opts.ignoreErrors) return String(e?.stdout ?? "");
    throw new Error(String(e?.stderr ?? e?.stdout ?? e?.message ?? e).trim());
  }
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "serve-sim-perm-"));
}

// ─── Location writer ───

// locationd owns clients.plist and keys app entries with an `i<bundleId>:`
// scheme — the trailing colon is part of the key, so neither plutil (dot
// paths) nor PlistBuddy (colon paths) can address it, and a hand-written
// plain-bundle-id entry is ignored. `simctl privacy` understands the format
// and is reliable specifically for location, so delegate to it here.
function setLocation(
  udid: string,
  bundleId: string,
  mode: "grant" | "revoke" | "reset",
  value: string | undefined,
): void {
  let action = "grant";
  let service = "location";
  if (mode === "reset") {
    action = "reset";
  } else if (mode === "revoke" || value === "never") {
    action = "revoke";
  } else if (value === "always") {
    service = "location-always";
  }
  try {
    execFileSync("xcrun", ["simctl", "privacy", udid, action, service, bundleId], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e: any) {
    throw new Error(
      `simctl privacy ${action} ${service} failed: ` +
        String(e?.stderr ?? e?.message ?? e).trim(),
    );
  }
}

function readLocation(
  udid: string,
  bundleId: string | undefined,
): { Authorization: number } | null {
  if (!bundleId) return null;
  const path = locationdPlistPath(udid);
  if (!existsSync(path)) return null;
  let xml: string;
  try {
    xml = plutil(["-convert", "xml1", "-o", "-", path]);
  } catch {
    return null;
  }
  const m = xml.match(
    new RegExp(
      `<key>i${bundleId.replace(/[.-]/g, "\\$&")}:</key>\\s*<dict>[\\s\\S]*?` +
        `<key>Authorization</key>\\s*<integer>(\\d+)</integer>`,
    ),
  );
  return m ? { Authorization: Number(m[1]) } : null;
}

// ─── Notifications writer ───

// Keyed-archive template for a single app's BulletinBoard section info, lifted
// verbatim from AppleSimulatorUtils (SetNotificationsPermission.m). `$objects`
// indices 2/3/5 are patched per-app: 2 = bundle id, 3 = the settings dict
// (allowsNotifications / criticalAlertSetting), 5 = display name.
const NOTIF_TEMPLATE_B64 =
  "YnBsaXN0MDDUAQIDBAUGTU5YJHZlcnNpb25YJG9iamVjdHNZJGFyY2hpdmVyVCR0b3ASAAGGoKgHCDAxQUgfSVUkbnVsbN8QFQkKCwwNDg8QERITFBUWFxgZGhscHR4fHiEiIx4jJicfHygjIh8jIyMjI18QFHN1cHByZXNzRnJvbVNldHRpbmdzXxASc3VwcHJlc3NlZFNldHRpbmdzWmhpZGVXZWVBcHBZc2VjdGlvbklEW2Rpc3BsYXlOYW1lVGljb25fEBlkaXNwbGF5c0NyaXRpY2FsQnVsbGV0aW5zW3N1YnNlY3Rpb25zXxATc2VjdGlvbkluZm9TZXR0aW5nc1YkY2xhc3NfEA9zZWN0aW9uQ2F0ZWdvcnlfEBJzdWJzZWN0aW9uUHJpb3JpdHlXdmVyc2lvbl8QGm1hbmFnZWRTZWN0aW9uSW5mb1NldHRpbmdzV2FwcE5hbWVbc2VjdGlvblR5cGVfEBBmYWN0b3J5U2VjdGlvbklEXxAPZGF0YVByb3ZpZGVySURzXHN1YnNlY3Rpb25JRFdmaWx0ZXJzXxAYcGF0aFRvV2VlQXBwUGx1Z2luQnVuZGxlCBAACIACgAWAAAiAAIADgAeABoAAgAWAAIAAgACAAIAAXxAmY29tLkxlb05hdGFuLkxOUG9wdXBDb250cm9sbGVyRXhhbXBsZS3ZMjM0NTY3Ejg5Ojs7Ox8fPjtAXHB1c2hTZXR0aW5nc18QGXNob3dzSW5Ob3RpZmljYXRpb25DZW50ZXJfEBNhbGxvd3NOb3RpZmljYXRpb25zXxAWc2hvd3NPbkV4dGVybmFsRGV2aWNlc18QFWNvbnRlbnRQcmV2aWV3U2V0dGluZ15jYXJQbGF5U2V0dGluZ18QEXNob3dzSW5Mb2NrU2NyZWVuWWFsZXJ0VHlwZRA/CQkJgAQJEAHSQkNERVokY2xhc3NuYW1lWCRjbGFzc2VzXxAVQkJTZWN0aW9uSW5mb1NldHRpbmdzokZHXxAVQkJTZWN0aW9uSW5mb1NldHRpbmdzWE5TT2JqZWN0V0xOUG9wdXDSQkNKS11CQlNlY3Rpb25JbmZvokxHXUJCU2VjdGlvbkluZm9fEA9OU0tleWVkQXJjaGl2ZXLRT1BUcm9vdIABAAgAEQAaACMALQAyADcAQABGAHMAigCfAKoAtADAAMUA4QDtAQMBCgEcATEBOQFWAV4BagF9AY8BnAGkAb8BwAHCAcMBxQHHAckBygHMAc4B0AHSAdQB1gHYAdoB3AHeAeACCQIcAikCRQJbAnQCjAKbAq8CuQK7ArwCvQK+AsACwQLDAsgC0wLcAvQC9wMPAxgDIAMlAzMDNgNEA1YDWQNeAAAAAAAAAgEAAAAAAAAAUQAAAAAAAAAAAAAAAAAAA2A=";

function bulletinPlistPath(udid: string): string {
  return join(bulletinDir(udid), "VersionedSectionInfo.plist");
}

/**
 * Write the per-app section-info keyed archive to a temp file and return its
 * path. The result is a binary plist suitable for `Import`ing as a `<data>`
 * value into the destination BulletinBoard plist.
 */
function buildSectionInfoBlob(
  dir: string,
  bundleId: string,
  enabled: boolean,
  critical: boolean,
): string {
  const blob = join(dir, "section-info.plist");
  writeFileSync(blob, Buffer.from(NOTIF_TEMPLATE_B64, "base64"));
  plistBuddy(blob, [
    `Set :$objects:2 ${bundleId}`,
    `Set :$objects:3:allowsNotifications ${enabled ? "true" : "false"}`,
    `Add :$objects:3:criticalAlertSetting integer ${critical ? 2 : 0}`,
    `Set :$objects:5 ${bundleId}`,
    "Save",
  ]);
  // PlistBuddy rewrites as XML; SpringBoard stores these archives as binary.
  plutil(["-convert", "binary1", blob]);
  return blob;
}

function setNotifications(
  udid: string,
  bundleId: string,
  mode: "grant" | "critical" | "revoke" | "reset",
): void {
  const path = bulletinPlistPath(udid);
  if (!existsSync(path)) {
    // The plist appears shortly after SpringBoard starts. `reset` on a store
    // that doesn't exist yet is a no-op (nothing to clear); grant/revoke wait
    // briefly for it before giving up.
    if (mode === "reset") return;
    const deadline = Date.now() + 5000;
    while (!existsSync(path) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!existsSync(path)) {
      throw new Error(
        `BulletinBoard plist not found for ${udid}. The simulator may still ` +
          `be booting — wait for it to finish and retry.\n  ${path}`,
      );
    }
  }

  // VersionedSectionInfo.plist is held immutable so SpringBoard doesn't clobber
  // it; clear the flag to edit, restore it afterwards.
  try {
    execFileSync("chflags", ["nouchg", path]);
  } catch {}

  const tmp = makeTmpDir();
  try {
    // Drop any existing entry so grant/revoke/reset are all idempotent.
    plistBuddy(path, [`Delete :sectionInfo:${bundleId}`, "Save"], {
      ignoreErrors: true,
    });
    if (mode !== "reset") {
      const blob = buildSectionInfoBlob(
        tmp,
        bundleId,
        mode !== "revoke",
        mode === "critical",
      );
      plistBuddy(path, [`Import :sectionInfo:${bundleId} ${blob}`, "Save"]);
    }
    // PlistBuddy saves XML; keep the file binary like SpringBoard writes it.
    plutil(["-convert", "binary1", path]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    try {
      chmodSync(path, 0o644);
      execFileSync("chflags", ["uchg", path]);
    } catch {}
  }
}

function readNotifications(
  udid: string,
  bundleId: string | undefined,
): { allowsNotifications: boolean; critical: boolean } | null {
  if (!bundleId) return null;
  const path = bulletinPlistPath(udid);
  if (!existsSync(path)) return null;
  let sectionInfo: string;
  try {
    sectionInfo = plutil(["-extract", "sectionInfo", "xml1", "-o", "-", path]);
  } catch {
    return null;
  }
  const m = sectionInfo.match(
    new RegExp(
      `<key>${bundleId.replace(/[.-]/g, "\\$&")}</key>\\s*<data>([\\s\\S]*?)</data>`,
    ),
  );
  if (!m?.[1]) return null;
  const tmp = makeTmpDir();
  try {
    const blob = join(tmp, "section-info.plist");
    writeFileSync(blob, Buffer.from(m[1].replace(/\s/g, ""), "base64"));
    const inner = plutil(["-convert", "xml1", "-o", "-", blob]);
    return {
      allowsNotifications: /<key>allowsNotifications<\/key>\s*<true\/>/.test(inner),
      critical: /<key>criticalAlertSetting<\/key>\s*<integer>2<\/integer>/.test(inner),
    };
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── Dispatch ───

function applyOne(
  udid: string,
  verb: Exclude<Verb, "list">,
  permission: string,
  value: string | undefined,
  bundleId: string,
): void {
  const spec = resolvePermission(permission)!;
  if (spec.kind === "tcc") {
    const authValue: number | "delete" =
      verb === "reset"
        ? "delete"
        : verb === "revoke"
          ? 0
          : value === "limited"
            ? 3
            : 2;
    writeTcc(udid, spec.tccService!, spec.tccAuthVersion!, bundleId, authValue);
  } else if (spec.kind === "notifications") {
    const mode =
      verb === "reset"
        ? "reset"
        : verb === "revoke"
          ? "revoke"
          : value === "critical"
            ? "critical"
            : "grant";
    setNotifications(udid, bundleId, mode);
  } else {
    setLocation(udid, bundleId, verb, value);
  }
}

export async function permissions(args: string[]): Promise<void> {
  const quiet = args.includes("-q") || args.includes("--quiet");
  const rest = args.filter((a) => a !== "-q" && a !== "--quiet");
  const parsed = parsePermissionsArgs(rest);

  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(
      "\nUsage:\n" +
        "  serve-sim permissions grant  <permission> <bundle-id> [--value <v>] [-d <udid|name>]\n" +
        "  serve-sim permissions revoke <permission> <bundle-id> [-d <udid|name>]\n" +
        "  serve-sim permissions reset  <permission|all> <bundle-id> [-d <udid|name>]\n" +
        "  serve-sim permissions list   [bundle-id] [-d <udid|name>]\n" +
        `\nPermissions: ${allPermissionNames().join(", ")}`,
    );
    process.exit(1);
  }

  const udid = parsed.device ? resolveDevice(parsed.device) : findBootedDevice();
  if (!udid) {
    console.error("No booted simulator. Boot one or pass -d <udid|name>.");
    process.exit(1);
  }

  if (parsed.verb === "list") {
    const result = {
      udid,
      bundleId: parsed.bundleId ?? null,
      tcc: readTcc(udid, parsed.bundleId),
      location: readLocation(udid, parsed.bundleId),
      notifications: readNotifications(udid, parsed.bundleId),
    };
    console.log(JSON.stringify(result, null, quiet ? 0 : 2));
    process.exit(0);
  }

  const bundleId = parsed.bundleId!;
  try {
    if (parsed.permission === "all") {
      for (const name of allPermissionNames()) {
        applyOne(udid, "reset", name, undefined, bundleId);
      }
    } else {
      applyOne(udid, parsed.verb, parsed.permission!, parsed.value, bundleId);
    }
  } catch (e: any) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }

  if (quiet) {
    console.log(
      JSON.stringify({
        udid,
        verb: parsed.verb,
        permission: parsed.permission,
        value: parsed.value ?? null,
        bundleId,
      }),
    );
  } else {
    const valueStr = parsed.value ? ` (${parsed.value})` : "";
    console.log(
      `🔐 ${parsed.verb} ${parsed.permission}${valueStr} for ${bundleId} on ${udid}`,
    );
  }
  process.exit(0);
}
