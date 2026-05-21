import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Drives the built CLI against whatever simulator is already booted (the CI
// `sim-test.yml` job boots one before running this directory). Each assertion
// reads the underlying state store the simulator actually consults — TCC.db,
// the BulletinBoard plist, locationd's clients.plist — rather than trusting
// `xcrun simctl privacy`, which is the whole reason this command exists.

const FAKE_BUNDLE = "com.serve-sim.permissions-e2e";
// Location goes through `simctl privacy`, which no-ops on a bundle id that
// isn't installed — so location assertions need a real stock app.
const REAL_APP = "com.apple.mobilecal";
const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");

function bootedUdid(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    // Prefer an iOS device — a dev machine may also have a booted watchOS or
    // tvOS sim, which don't share the same permission state layout.
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!/iOS/i.test(runtime)) continue;
      for (const d of devices) if (d.state === "Booted") return d.udid;
    }
    for (const devices of Object.values(data.devices)) {
      for (const d of devices) if (d.state === "Booted") return d.udid;
    }
  } catch {}
  return null;
}

const udid = bootedUdid();
// Needs both a booted iOS sim and the built CLI. CI builds serve-sim before
// running this directory; locally, run `bun run build.ts` first or it skips.
const describeIfSim = udid && existsSync(CLI) ? describe : describe.skip;

function cli(...args: string[]): string {
  return execFileSync("node", [CLI, "permissions", ...args], { encoding: "utf-8" });
}

function libDir(): string {
  return join(
    homedir(),
    "Library/Developer/CoreSimulator/Devices",
    udid!,
    "data/Library",
  );
}

function tccAuthValue(service: string): string {
  const db = join(libDir(), "TCC/TCC.db");
  return execSync(
    `sqlite3 "${db}" "SELECT auth_value FROM access WHERE service='${service}' AND client='${FAKE_BUNDLE}';"`,
    { encoding: "utf-8" },
  ).trim();
}

function bulletinXml(): string {
  const plist = join(libDir(), "BulletinBoard/VersionedSectionInfo.plist");
  return execSync(`plutil -convert xml1 -o - "${plist}"`, { encoding: "utf-8" });
}

// Decode the per-app section-info keyed archive nested as a <data> blob under
// `sectionInfo.<bundleId>`. `plutil -extract` can't address the dotted bundle
// id, so pull the whole sectionInfo dict and find the entry by hand.
function sectionInfoInnerXml(): string {
  const plist = join(libDir(), "BulletinBoard/VersionedSectionInfo.plist");
  const xml = execSync(`plutil -extract sectionInfo xml1 -o - "${plist}"`, {
    encoding: "utf-8",
  });
  const m = xml.match(
    new RegExp(
      `<key>${FAKE_BUNDLE.replace(/[.-]/g, "\\$&")}</key>\\s*<data>([\\s\\S]*?)</data>`,
    ),
  );
  if (!m?.[1]) throw new Error(`no sectionInfo entry for ${FAKE_BUNDLE}`);
  const blob = Buffer.from(m[1].replace(/\s/g, ""), "base64");
  const tmp = join(libDir(), "..", `.serve-sim-e2e-${Date.now()}.plist`);
  require("fs").writeFileSync(tmp, blob);
  try {
    return execSync(`plutil -convert xml1 -o - "${tmp}"`, { encoding: "utf-8" });
  } finally {
    require("fs").rmSync(tmp, { force: true });
  }
}

// locationd keys entries as `i<bundleId>:`; pull the Authorization integer out
// of that entry's dict.
function locationAuth(bundleId: string): number | null {
  const plist = join(libDir(), "Caches/locationd/clients.plist");
  if (!existsSync(plist)) return null;
  const xml = execSync(`plutil -convert xml1 -o - "${plist}"`, {
    encoding: "utf-8",
  });
  const m = xml.match(
    new RegExp(
      `<key>i${bundleId.replace(/[.-]/g, "\\$&")}:</key>\\s*<dict>[\\s\\S]*?` +
        `<key>Authorization</key>\\s*<integer>(\\d+)</integer>`,
    ),
  );
  return m ? Number(m[1]) : null;
}

// Each case shells the built CLI a few times, and a cold `simctl privacy`
// call (location) can take several seconds on a fresh CI sim — comfortably
// past bun's 5s default. The beforeAll reset-all also cascades through every
// permission while the sim is fully cold, and that first touch has been seen
// to run past 90s on a GitHub macOS runner, so keep the budget well above it.
const T = 150_000;

describeIfSim("serve-sim permissions (real simulator)", () => {
  beforeAll(() => {
    // Start from a known-clean slate for the fake bundle.
    cli("reset", "all", FAKE_BUNDLE);
  }, T);

  test("grant camera writes a TCC row with auth_value=2", () => {
    cli("grant", "camera", FAKE_BUNDLE);
    expect(tccAuthValue("kTCCServiceCamera")).toBe("2");
  }, T);

  test("revoke camera flips auth_value to 0", () => {
    cli("revoke", "camera", FAKE_BUNDLE);
    expect(tccAuthValue("kTCCServiceCamera")).toBe("0");
  }, T);

  test("reset camera removes the TCC row", () => {
    cli("grant", "camera", FAKE_BUNDLE);
    cli("reset", "camera", FAKE_BUNDLE);
    expect(tccAuthValue("kTCCServiceCamera")).toBe("");
  }, T);

  test("grant photos --value limited writes auth_value=3", () => {
    cli("grant", "photos", FAKE_BUNDLE, "--value", "limited");
    expect(tccAuthValue("kTCCServicePhotos")).toBe("3");
  }, T);

  test("grant notifications sets allowsNotifications=true in BulletinBoard", () => {
    cli("grant", "notifications", FAKE_BUNDLE);
    expect(bulletinXml()).toContain(FAKE_BUNDLE);
    expect(sectionInfoInnerXml()).toMatch(
      /<key>allowsNotifications<\/key>\s*<true\/>/,
    );
  }, T);

  test("grant notifications --value critical sets criticalAlertSetting=2", () => {
    cli("grant", "notifications", FAKE_BUNDLE, "--value", "critical");
    expect(sectionInfoInnerXml()).toMatch(
      /<key>criticalAlertSetting<\/key>\s*<integer>2<\/integer>/,
    );
  }, T);

  test("revoke notifications sets allowsNotifications=false", () => {
    cli("revoke", "notifications", FAKE_BUNDLE);
    expect(sectionInfoInnerXml()).toMatch(
      /<key>allowsNotifications<\/key>\s*<false\/>/,
    );
  }, T);

  test("reset notifications removes the bundle entry", () => {
    cli("grant", "notifications", FAKE_BUNDLE);
    cli("reset", "notifications", FAKE_BUNDLE);
    expect(bulletinXml()).not.toContain(FAKE_BUNDLE);
  }, T);

  test("grant location --value always writes Authorization=4", () => {
    cli("grant", "location", REAL_APP, "--value", "always");
    expect(locationAuth(REAL_APP)).toBe(4);
  }, T);

  test("revoke location downgrades Authorization to never (1)", () => {
    cli("revoke", "location", REAL_APP);
    expect(locationAuth(REAL_APP)).toBe(1);
    cli("reset", "location", REAL_APP);
  }, T);

  test("reset all clears the TCC and notification stores for the bundle", () => {
    cli("grant", "camera", FAKE_BUNDLE);
    cli("grant", "notifications", FAKE_BUNDLE);
    cli("reset", "all", FAKE_BUNDLE);
    expect(tccAuthValue("kTCCServiceCamera")).toBe("");
    expect(bulletinXml()).not.toContain(FAKE_BUNDLE);
  }, T);

  test("list reports state under the CLI's own permission names", () => {
    cli("grant", "camera", FAKE_BUNDLE);
    cli("grant", "notifications", FAKE_BUNDLE);
    cli("grant", "location", REAL_APP, "--value", "always");
    const fake = JSON.parse(cli("list", FAKE_BUNDLE));
    expect(fake.tcc.camera).toBe(2);
    expect(fake.notifications.allowsNotifications).toBe(true);
    const realOut = JSON.parse(cli("list", REAL_APP));
    expect(realOut.udid).toBe(udid);
    expect(realOut.location.Authorization).toBe(4);
    cli("reset", "all", FAKE_BUNDLE);
    cli("reset", "location", REAL_APP);
  }, T);
});
