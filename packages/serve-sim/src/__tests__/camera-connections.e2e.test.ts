import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const BUNDLE_ID = "dev.servesim.camera-connection-test";
const RESULT_FILE = "simcam-connection-result.json";
const PKG_DIR = join(import.meta.dir, "../..");
const DYLIB = join(PKG_DIR, "dist/simcam/libSimCameraInjector.dylib");
const TEST_SOURCE = join(PKG_DIR, "Tests/SimCameraConnectionTestApp/main.m");

function bootedUdid(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!/iOS/i.test(runtime)) continue;
      for (const device of devices) {
        if (device.state === "Booted") return device.udid;
      }
    }
  } catch {}
  return null;
}

const udid = bootedUdid();
const describeIfSimulator = udid && existsSync(DYLIB) ? describe : describe.skip;
let buildDir: string | null = null;
let resultPath: string | null = null;

describeIfSimulator("synthetic camera connection graph", () => {
  beforeAll(() => {
    buildDir = mkdtempSync(join(tmpdir(), "serve-sim-camera-connection-test-"));
    const appDir = join(buildDir, "SimCameraConnectionTest.app");
    execFileSync("mkdir", ["-p", appDir]);

    const sdk = execFileSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], {
      encoding: "utf-8",
    }).trim();
    execFileSync("xcrun", [
      "--sdk", "iphonesimulator", "clang",
      "-arch", "arm64", "-arch", "x86_64",
      "-mios-simulator-version-min=15.0",
      "-isysroot", sdk,
      "-fobjc-arc", "-fmodules",
      "-framework", "Foundation",
      "-framework", "UIKit",
      "-framework", "AVFoundation",
      "-o", join(appDir, "SimCameraConnectionTest"),
      TEST_SOURCE,
    ]);
    writeFileSync(join(appDir, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>SimCameraConnectionTest</string>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>SimCameraConnectionTest</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>MinimumOSVersion</key><string>15.0</string>
</dict></plist>\n`);

    try {
      execFileSync("xcrun", ["simctl", "uninstall", udid!, BUNDLE_ID]);
    } catch {}
    execFileSync("xcrun", ["simctl", "install", udid!, appDir]);
    const dataContainer = execFileSync(
      "xcrun",
      ["simctl", "get_app_container", udid!, BUNDLE_ID, "data"],
      { encoding: "utf-8" },
    ).trim();
    resultPath = join(dataContainer, "Documents", RESULT_FILE);
    try {
      unlinkSync(resultPath);
    } catch {}
  }, 60_000);

  afterAll(() => {
    try {
      execFileSync("xcrun", ["simctl", "uninstall", udid!, BUNDLE_ID]);
    } catch {}
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  });

  test("preserves no-connections state until the explicit connection is added", async () => {
    execFileSync("xcrun", ["simctl", "launch", udid!, BUNDLE_ID], {
      env: {
        ...process.env,
        SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: DYLIB,
      },
    });

    const deadline = Date.now() + 10_000;
    while (resultPath && !existsSync(resultPath) && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    expect(resultPath && existsSync(resultPath)).toBe(true);
    const result = JSON.parse(readFileSync(resultPath!, "utf-8")) as {
      passed: boolean;
      message: string;
    };
    expect(result.passed, result.message).toBe(true);
  }, 20_000);
});
