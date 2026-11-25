/**
 * Inspect an .ipa for `serve-sim install`: app metadata from Info.plist,
 * the embedded provisioning profile, and whether the build can be installed
 * over the air at all. Pure Node, so it runs on Linux CI.
 */
import { extractProvisionPlist, parsePlist, type PlistDict, type PlistValue } from "./install-plist";
import { ZipReader, type ZipEntry } from "./install-zip";

const MAX_INFO_PLIST = 4 * 1024 * 1024;
const MAX_PROFILE = 4 * 1024 * 1024;
const MAX_ICON = 2 * 1024 * 1024;

export type ProfileKind = "development" | "ad-hoc" | "enterprise" | "app-store";

export interface ProfileInfo {
  kind: ProfileKind;
  name?: string;
  teamName?: string;
  teamId?: string;
  uuid?: string;
  expiresAt?: string;
  expired: boolean;
  applicationIdentifier?: string;
  /** False when the profile's app id doesn't cover the bundle id. */
  bundleIdMatches: boolean;
  getTaskAllow: boolean;
  devices: string[];
}

export interface IpaInfo {
  appName: string;
  bundleId: string;
  version: string;
  build: string;
  /** e.g. `Payload/OTATest.app/` */
  appDir: string;
  signed: boolean;
  profile?: ProfileInfo;
  icon?: Buffer;
  warnings: string[];
}

function isDict(value: PlistValue | undefined): value is PlistDict {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !Buffer.isBuffer(value);
}

function str(value: PlistValue | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function strings(value: PlistValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Does a profile `application-identifier` (`TEAM.com.foo`, `TEAM.*`, `TEAM.com.*`) cover `bundleId`?
 * @lintignore Exported for tests.
 */
export function appIdMatches(applicationIdentifier: string, bundleId: string): boolean {
  const dot = applicationIdentifier.indexOf(".");
  const pattern = dot >= 0 ? applicationIdentifier.slice(dot + 1) : applicationIdentifier;
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return bundleId.startsWith(pattern.slice(0, -1));
  return pattern === bundleId;
}

/** @lintignore Exported for tests. */
export function classifyProfile(profile: PlistDict, bundleId: string, now: Date = new Date()): ProfileInfo {
  const entitlements = isDict(profile.Entitlements) ? profile.Entitlements : {};
  const devices = strings(profile.ProvisionedDevices);
  const getTaskAllow = entitlements["get-task-allow"] === true;
  const allDevices = profile.ProvisionsAllDevices === true;
  const kind: ProfileKind = allDevices
    ? "enterprise"
    : devices.length > 0
      ? getTaskAllow ? "development" : "ad-hoc"
      : "app-store";
  const expiration = profile.ExpirationDate instanceof Date ? profile.ExpirationDate : undefined;
  const applicationIdentifier = str(entitlements["application-identifier"]);
  return {
    kind,
    name: str(profile.Name),
    teamName: str(profile.TeamName),
    teamId: strings(profile.TeamIdentifier)[0],
    uuid: str(profile.UUID),
    expiresAt: expiration?.toISOString(),
    expired: expiration ? expiration.getTime() < now.getTime() : false,
    applicationIdentifier,
    bundleIdMatches: applicationIdentifier ? appIdMatches(applicationIdentifier, bundleId) : true,
    getTaskAllow,
    devices,
  };
}

const KIND_LABEL: Record<ProfileKind, string> = {
  development: "Development",
  "ad-hoc": "Ad Hoc",
  enterprise: "Enterprise (In-House)",
  "app-store": "App Store / TestFlight",
};

export function profileKindLabel(kind: ProfileKind): string {
  return KIND_LABEL[kind];
}

/** Warnings about installing this build OTA. Empty means it should install. */
function installWarnings(info: { signed: boolean; profile?: ProfileInfo; bundleId: string }): string[] {
  const out: string[] = [];
  if (!info.signed || !info.profile) {
    out.push("Unsigned (no embedded.mobileprovision or _CodeSignature): not installable OTA. Export an Ad Hoc / Development build.");
  }
  const p = info.profile;
  if (!p) return out;
  if (p.kind === "app-store") {
    out.push("App Store / TestFlight profile: iOS won't install it OTA. Export with Release Testing (Ad Hoc) or Debugging (Development).");
  }
  if (p.expired) out.push(`Provisioning profile expired ${p.expiresAt?.slice(0, 10) ?? ""}`.trim() + ".");
  if (!p.bundleIdMatches) {
    out.push(`Profile app id ${p.applicationIdentifier} doesn't match bundle id ${info.bundleId}.`);
  }
  return out;
}

function findApp(zip: ZipReader): { appDir: string; infoPlist: ZipEntry } {
  const candidates = zip.entries.filter((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name));
  if (candidates.length === 0) throw new Error("Not an iOS app archive: no Payload/<Name>.app/Info.plist");
  const infoPlist = candidates[0]!;
  return { appDir: infoPlist.name.slice(0, -"Info.plist".length), infoPlist };
}

/**
 * PNG signature, and whether it's Apple's CgBI-crushed variant (a CgBI chunk before IHDR).
 * @lintignore Exported for tests.
 */
export function pngKind(buf: Buffer): "png" | "cgbi" | "not-png" {
  if (buf.length < 16 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return "not-png";
  return buf.toString("latin1", 12, 16) === "CgBI" ? "cgbi" : "png";
}

function findIcon(zip: ZipReader, appDir: string, info: PlistDict): Buffer | undefined {
  const names = new Set<string>();
  for (const key of ["CFBundleIcons", "CFBundleIcons~ipad"]) {
    const icons = info[key];
    const primary = isDict(icons) ? icons.CFBundlePrimaryIcon : undefined;
    if (isDict(primary)) for (const n of strings(primary.CFBundleIconFiles)) names.add(n);
  }
  for (const n of strings(info.CFBundleIconFiles)) names.add(n);
  if (names.size === 0) return undefined;
  const wanted = [...names].map((n) => n.replace(/\.png$/i, ""));
  const matches = zip.entries.filter((e) => {
    if (!e.name.startsWith(appDir)) return false;
    const rest = e.name.slice(appDir.length);
    if (rest.includes("/")) return false;
    return wanted.some((w) => rest.startsWith(w) && /^(?:@\dx)?(?:~ipad)?\.png$/i.test(rest.slice(w.length)));
  });
  matches.sort((a, b) => b.size - a.size);
  for (const entry of matches) {
    if (entry.size > MAX_ICON) continue;
    try {
      const png = zip.readEntry(entry, MAX_ICON);
      if (pngKind(png) === "png") return png;
    } catch {}
  }
  return undefined;
}

export function inspectIpa(path: string, now: Date = new Date()): IpaInfo {
  const zip = ZipReader.open(path);
  try {
    const { appDir, infoPlist } = findApp(zip);
    const info = parsePlist(zip.readEntry(infoPlist, MAX_INFO_PLIST));
    if (!isDict(info)) throw new Error("Info.plist is not a dictionary");
    const bundleId = str(info.CFBundleIdentifier);
    if (!bundleId) throw new Error("Info.plist has no CFBundleIdentifier");
    const dirName = appDir.slice("Payload/".length, -".app/".length);
    const appName = str(info.CFBundleDisplayName) ?? str(info.CFBundleName) ?? dirName;
    const version = str(info.CFBundleShortVersionString) ?? str(info.CFBundleVersion) ?? "0";
    const build = str(info.CFBundleVersion) ?? version;

    const profileEntry = zip.get(`${appDir}embedded.mobileprovision`);
    const codeResources = zip.get(`${appDir}_CodeSignature/CodeResources`);
    let profile: ProfileInfo | undefined;
    const warnings: string[] = [];
    if (profileEntry) {
      try {
        profile = classifyProfile(extractProvisionPlist(zip.readEntry(profileEntry, MAX_PROFILE)), bundleId, now);
      } catch (error) {
        warnings.push(`Could not read embedded.mobileprovision: ${(error as Error).message}`);
      }
    }
    const signed = !!profileEntry && !!codeResources;
    warnings.push(...installWarnings({ signed, profile, bundleId }));
    let icon: Buffer | undefined;
    try {
      icon = findIcon(zip, appDir, info);
    } catch {}
    return { appName, bundleId, version, build, appDir, signed, profile, icon, warnings };
  } finally {
    zip.close();
  }
}

/** `included` / `NOT included` line for `--udid`, case-insensitive. */
export function udidStatus(profile: ProfileInfo | undefined, udid: string): "included" | "not-included" | "all-devices" | "no-profile" {
  if (!profile) return "no-profile";
  if (profile.kind === "enterprise") return "all-devices";
  const want = udid.trim().toLowerCase();
  return profile.devices.some((d) => d.toLowerCase() === want) ? "included" : "not-included";
}
