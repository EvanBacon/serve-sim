import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appIdMatches, classifyProfile, inspectIpa, pngKind, udidStatus } from "../install-ipa";
import { extractProvisionPlist } from "../install-plist";
import { fakePng, makeIpa, makeZip, mobileprovision, xmlPlist, type ProfileFixture } from "./install-fixtures";

const NOW = new Date("2026-11-24T12:00:00Z");
const UDID = "00008101-001A2B3C4D5E6F70";
const dir = mkdtempSync(join(tmpdir(), "install-ipa-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function ipaFile(buf: Buffer): string {
  const p = join(dir, `t${n++}.ipa`);
  writeFileSync(p, buf);
  return p;
}
const classify = (p: ProfileFixture, bundleId = "com.example.app") =>
  classifyProfile(extractProvisionPlist(mobileprovision(p)), bundleId, NOW);

describe("provisioning profile classification", () => {
  test("development: get-task-allow + devices", () => {
    const p = classify({ getTaskAllow: true, devices: [UDID] });
    expect(p.kind).toBe("development");
    expect(p.devices).toEqual([UDID]);
    expect(p.teamName).toBe("Example Team");
    expect(p.teamId).toBe("ABCDE12345");
    expect(p.expired).toBe(false);
    expect(p.bundleIdMatches).toBe(true);
  });

  test("ad hoc: devices without get-task-allow", () => {
    expect(classify({ getTaskAllow: false, devices: [UDID, "OTHER"] }).kind).toBe("ad-hoc");
  });

  test("enterprise: ProvisionsAllDevices", () => {
    expect(classify({ allDevices: true }).kind).toBe("enterprise");
  });

  test("app store / testflight: neither", () => {
    expect(classify({}).kind).toBe("app-store");
  });

  test("expired", () => {
    const p = classify({ devices: [UDID], expires: new Date("2026-11-01T00:00:00Z") });
    expect(p.expired).toBe(true);
    expect(p.expiresAt).toBe("2026-11-01T00:00:00.000Z");
  });

  test("bundle id mismatch and wildcards", () => {
    expect(classify({ devices: [UDID], appId: "ABCDE12345.com.other.app" }).bundleIdMatches).toBe(false);
    expect(classify({ devices: [UDID], appId: "ABCDE12345.*" }).bundleIdMatches).toBe(true);
    expect(classify({ devices: [UDID], appId: "ABCDE12345.com.example.*" }).bundleIdMatches).toBe(true);
    expect(appIdMatches("T.com.example.*", "com.examples.app")).toBe(false);
    expect(appIdMatches("T.com.example.app", "com.example.app.extra")).toBe(false);
  });

  test("udid check", () => {
    const dev = classify({ getTaskAllow: true, devices: [UDID] });
    expect(udidStatus(dev, UDID.toLowerCase())).toBe("included");
    expect(udidStatus(dev, "00008140-FFFFFFFFFFFFFFFF")).toBe("not-included");
    expect(udidStatus(classify({ allDevices: true }), "anything")).toBe("all-devices");
    expect(udidStatus(undefined, UDID)).toBe("no-profile");
  });
});

describe("inspectIpa", () => {
  test("development build: metadata, profile, no warnings", () => {
    const info = inspectIpa(ipaFile(makeIpa({
      info: xmlPlist({ CFBundleIdentifier: "com.example.app", CFBundleDisplayName: "My App", CFBundleName: "MyApp", CFBundleShortVersionString: "2.1", CFBundleVersion: "99" }),
      profile: mobileprovision({ getTaskAllow: true, devices: [UDID] }),
    })), NOW);
    expect(info).toMatchObject({ appName: "My App", bundleId: "com.example.app", version: "2.1", build: "99", appDir: "Payload/Example.app/", signed: true });
    expect(info.profile?.kind).toBe("development");
    expect(info.warnings).toEqual([]);
  });

  test("binary Info.plist, CFBundleName fallback", () => {
    // Written by Python plistlib (FMT_BINARY); install-plist.test.ts covers plutil output.
    const bplist = Buffer.from(
      "YnBsaXN0MDDTAQIDBAUGXxASQ0ZCdW5kbGVJZGVudGlmaWVyXENGQnVuZGxlTmFtZV8QGkNGQnVuZGxlU2hvcnRWZXJzaW9uU3RyaW5nXxAPY29tLmV4YW1wbGUuYXBwV0V4YW1wbGVTMy4wCA8kMU5gaAAAAAAAAAEBAAAAAAAAAAcAAAAAAAAAAAAAAAAAAABs",
      "base64",
    );
    const info = inspectIpa(ipaFile(makeIpa({ info: bplist })), NOW);
    expect(info.appName).toBe("Example");
    expect(info.version).toBe("3.0");
    expect(info.build).toBe("3.0");
  });

  test("unsigned: no profile, no CodeResources", () => {
    const info = inspectIpa(ipaFile(makeIpa({ profile: null, codeResources: false })), NOW);
    expect(info.signed).toBe(false);
    expect(info.warnings.join("\n")).toMatch(/Unsigned.*not installable OTA/);
  });

  test("profile but no CodeResources is still unsigned", () => {
    const info = inspectIpa(ipaFile(makeIpa({ codeResources: false })), NOW);
    expect(info.signed).toBe(false);
    expect(info.warnings[0]).toMatch(/Unsigned/);
  });

  test("app store, expired and mismatch warnings", () => {
    const info = inspectIpa(ipaFile(makeIpa({
      profile: mobileprovision({ appId: "ABCDE12345.com.other", expires: new Date("2026-01-01T00:00:00Z") }),
    })), NOW);
    const w = info.warnings.join("\n");
    expect(w).toMatch(/App Store \/ TestFlight profile/);
    expect(w).toMatch(/expired 2026-01-01/);
    expect(w).toMatch(/doesn't match bundle id com\.example\.app/);
  });

  test("not an app archive", () => {
    expect(() => inspectIpa(ipaFile(makeZip([{ name: "foo.txt", data: "x" }])), NOW)).toThrow(/no Payload/);
  });

  test("icon: largest plain PNG; CgBI-crushed PNGs are skipped", () => {
    const icons = { CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconFiles: ["AppIcon60x60"] } } };
    const info = xmlPlist({ CFBundleIdentifier: "com.example.app", CFBundleShortVersionString: "1", ...icons });
    const plain = fakePng(false, 500);
    const withIcon = inspectIpa(ipaFile(makeIpa({
      info,
      extra: [
        { name: "AppIcon60x60@2x.png", data: fakePng(false, 100) },
        { name: "AppIcon60x60@3x.png", data: plain },
        { name: "Other@3x.png", data: fakePng(false, 900) },
      ],
    })), NOW);
    expect(withIcon.icon?.equals(plain)).toBe(true);

    const crushed = inspectIpa(ipaFile(makeIpa({ info, extra: [{ name: "AppIcon60x60@3x.png", data: fakePng(true, 500) }] })), NOW);
    expect(crushed.icon).toBeUndefined();
    expect(pngKind(fakePng(true))).toBe("cgbi");
    expect(pngKind(Buffer.from("nope"))).toBe("not-png");
  });
});
