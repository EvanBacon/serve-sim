import { lstatSync } from "fs";
import { join } from "path";
import type { PlistRunner } from "./app-info-plist";

// What an installed app answers to: its custom URL schemes (Info.plist
// CFBundleURLTypes) and universal-link domains (the `applinks:` entries of
// its associated-domains entitlement). Used by the `linkingInfo` host action.

const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/i;

/** Lower-cased, de-duplicated CFBundleURLTypes[].CFBundleURLSchemes. */
export function urlSchemesFromInfoPlist(info: unknown): string[] {
  const types = (info as { CFBundleURLTypes?: unknown } | null)?.CFBundleURLTypes;
  if (!Array.isArray(types)) return [];
  const out: string[] = [];
  for (const type of types) {
    const schemes = (type as { CFBundleURLSchemes?: unknown } | null)?.CFBundleURLSchemes;
    const list = Array.isArray(schemes) ? schemes : typeof schemes === "string" ? [schemes] : [];
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const scheme = raw.trim().toLowerCase();
      if (SCHEME_RE.test(scheme) && !out.includes(scheme)) out.push(scheme);
    }
  }
  return out;
}

export function displayNameFromInfoPlist(info: unknown): string | null {
  const i = (info ?? {}) as Record<string, unknown>;
  for (const key of ["CFBundleDisplayName", "CFBundleName"]) {
    const v = i[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

const DOMAIN_RE = /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

/**
 * Universal-link hosts from associated-domains entries: only `applinks:`,
 * with any `?mode=developer|managed` suffix dropped. Wildcards (`*.x.com`)
 * are kept as written.
 */
export function applinksDomains(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const m = /^applinks:(.+)$/i.exec(entry.trim());
    if (!m) continue;
    const domain = m[1]!.split("?")[0]!.trim().toLowerCase();
    if (DOMAIN_RE.test(domain) && !out.includes(domain)) out.push(domain);
  }
  return out;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e.toLowerCase()] ?? _;
  });
}

/**
 * The `com.apple.developer.associated-domains` strings of an XML
 * entitlements plist (codesign's `--xml` output or the raw
 * `__TEXT,__entitlements` section). Only this one top-level array is read,
 * so a small pattern match is enough; anything else yields [].
 */
export function associatedDomainsFromEntitlementsXml(xml: string): string[] {
  const m = /<key>\s*com\.apple\.developer\.associated-domains\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (!m) return [];
  return [...m[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((s) => decodeXml(s[1]!).trim());
}

/**
 * Bytes of the first section in `otool -X -s __TEXT __entitlements` output,
 * as text. otool prints `<address>\t<hex groups>` lines: 8-digit groups are
 * little-endian 32-bit words (so their bytes are reversed), 2-digit groups
 * single bytes (x86_64 slices, or a trailing partial word). A fat binary
 * repeats the section per slice; reading stops when the address goes back.
 */
export function entitlementsTextFromOtool(stdout: string): string {
  const bytes: number[] = [];
  let lastAddress = -1n;
  for (const line of stdout.split("\n")) {
    const m = /^([0-9a-f]{8,16})\t(.*)$/i.exec(line.trimEnd());
    if (!m) continue;
    const address = BigInt(`0x${m[1]}`);
    if (address <= lastAddress) break;
    lastAddress = address;
    for (const group of m[2]!.trim().split(/\s+/)) {
      if (!/^(?:[0-9a-f]{2})+$/i.test(group)) continue;
      const groupBytes: number[] = [];
      for (let i = 0; i < group.length; i += 2) groupBytes.push(parseInt(group.slice(i, i + 2), 16));
      if (groupBytes.length > 1) groupBytes.reverse();
      bytes.push(...groupBytes);
    }
  }
  while (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes.pop();
  return Buffer.from(bytes).toString("utf8");
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

/**
 * Universal-link domains of the app bundle at `appPath`. Simulator builds
 * are ad-hoc signed with their entitlements in the binary's
 * `__TEXT,__entitlements` section, which `codesign -d --entitlements`
 * often doesn't report, so both are read and merged. Best effort: [] when
 * neither has the entitlement.
 */
export async function readUniversalLinkDomains(
  appPath: string,
  info: Record<string, unknown> | null,
  run: PlistRunner,
): Promise<string[]> {
  const domains = new Set<string>();
  const add = (xml: string) => {
    for (const d of applinksDomains(associatedDomainsFromEntitlementsXml(xml))) domains.add(d);
  };
  const signed = await run("codesign", ["-d", "--entitlements", "-", "--xml", appPath]);
  if (signed.exitCode === 0) add(signed.stdout);

  const executable = info?.CFBundleExecutable;
  if (typeof executable === "string" && executable !== "" && !executable.includes("/") && !executable.includes("\u0000") && executable !== "..") {
    const binary = join(appPath, executable);
    if (isRegularFile(binary)) {
      const section = await run("otool", ["-X", "-s", "__TEXT", "__entitlements", binary]);
      if (section.exitCode === 0) add(entitlementsTextFromOtool(section.stdout));
    }
  }
  return [...domains];
}
