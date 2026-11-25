import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stripVTControlCharacters } from "util";
import { formatInstallBanner, installJson, parseTtl, prepareIpa } from "../install-command";
import type { IpaInfo } from "../install-ipa";
import { installUrls } from "../install-server";

const dir = mkdtempSync(join(tmpdir(), "install-command-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseTtl", () => {
  test("units and bare minutes", () => {
    expect(parseTtl("30m")).toBe(30 * 60_000);
    expect(parseTtl("2h")).toBe(2 * 3_600_000);
    expect(parseTtl("90s")).toBe(90_000);
    expect(parseTtl("1h30m")).toBe(90 * 60_000);
    expect(parseTtl("15")).toBe(15 * 60_000);
    expect(parseTtl(" 1.5h ")).toBe(90 * 60_000);
  });
  test("rejects nonsense, zero and more than 24h", () => {
    for (const bad of ["", "abc", "0", "0m", "-5m", "25h", "10d", "5 m", "m"]) expect(parseTtl(bad)).toBeNull();
    expect(parseTtl("24h")).toBe(24 * 3_600_000);
  });
});

describe("prepareIpa", () => {
  test("an .ipa file is used as is", () => {
    const p = join(dir, "a.ipa");
    writeFileSync(p, "x");
    const prepared = prepareIpa(p);
    expect(prepared.ipaPath).toBe(p);
    prepared.cleanup();
  });
  test("errors", () => {
    expect(() => prepareIpa(join(dir, "missing.ipa"))).toThrow(/No such file/);
    const plainDir = join(dir, "folder");
    mkdirSync(plainDir);
    expect(() => prepareIpa(plainDir)).toThrow(/Not an .ipa/);
    const app = join(dir, "X.app");
    mkdirSync(app);
    expect(() => prepareIpa(app, "linux")).toThrow(/needs macOS/);
    const archive = join(dir, "X.xcarchive");
    mkdirSync(join(archive, "Products", "Applications"), { recursive: true });
    expect(() => prepareIpa(archive, "linux")).toThrow(/found 0/);
  });
});

const info: IpaInfo = {
  appName: "OTA Test",
  bundleId: "com.example.app",
  version: "1.0",
  build: "7",
  appDir: "Payload/OTATest.app/",
  signed: true,
  profile: {
    kind: "development",
    name: "Dev",
    teamName: "Example Team",
    teamId: "ABCDE12345",
    expiresAt: "2026-11-29T08:26:34.000Z",
    expired: false,
    applicationIdentifier: "ABCDE12345.com.example.app",
    bundleIdMatches: true,
    getTaskAllow: true,
    devices: ["D1", "D2", "D3", "D4", "D5"],
  },
  warnings: [],
};
const urls = installUrls("https://x.trycloudflare.com", "CAPCAP", false);
const strip = stripVTControlCharacters;

describe("banner", () => {
  test("text banner", () => {
    const out = strip(formatInstallBanner({ info, urls, expiresAt: 1_800_000, now: 0, once: true, quick: true, qr: "QR", udid: undefined }));
    expect(out).toContain("OTA Test 1.0 (7)");
    expect(out).toContain("Bundle:   com.example.app");
    expect(out).toContain("Signing:  Development profile, team Example Team (ABCDE12345), expires 2026-11-29");
    expect(out).toContain("5 provisioned: D1, D2, D3 (+2 more)");
    expect(out).toContain("xcrun devicectl list devices");
    expect(out).toContain(`- Page:     ${urls.page}`);
    expect(out).toContain(`- Direct:   ${urls.itms}`);
    expect(out).toContain("(in 30m), or after one download");
    expect(out).toContain("Ctrl+C to stop");
    expect(out).not.toMatch(/token/i);
  });

  test("--udid not included", () => {
    const out = strip(formatInstallBanner({ info, urls, expiresAt: 60_000, now: 0, once: false, quick: false, qr: "QR", udid: { udid: "ZZZ", status: "not-included" } }));
    expect(out).toContain("UDID:     ZZZ NOT included");
    expect(out).not.toContain("quick tunnel");
  });

  test("--udid on an unsigned build", () => {
    const unsigned = { ...info, signed: false, profile: undefined };
    const out = strip(formatInstallBanner({ info: unsigned, urls, expiresAt: 60_000, now: 0, once: false, quick: false, qr: "QR", udid: { udid: "ZZZ", status: "no-profile" } }));
    expect(out).toContain("Signing:  unsigned");
    expect(out).toContain("UDID:     ZZZ unknown (no provisioning profile)");
  });

  test("json has full device list, urls, expiry and warnings", () => {
    const j = installJson({ info: { ...info, warnings: ["w"] }, urls, expiresAt: 0, once: false }) as any;
    expect(j.app).toEqual({ name: "OTA Test", bundleId: "com.example.app", version: "1.0", build: "7", signed: true, hasIcon: false });
    expect(j.profile.devices).toEqual(["D1", "D2", "D3", "D4", "D5"]);
    expect(j.urls.itms).toBe(urls.itms);
    expect(j.expiresAt).toBe("1970-01-01T00:00:00.000Z");
    expect(j.warnings).toEqual(["w"]);
  });
});
