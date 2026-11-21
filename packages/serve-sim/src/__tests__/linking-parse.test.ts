import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applinksDomains,
  associatedDomainsFromEntitlementsXml,
  displayNameFromInfoPlist,
  entitlementsTextFromOtool,
  readUniversalLinkDomains,
  urlSchemesFromInfoPlist,
} from "../linking";

describe("urlSchemesFromInfoPlist", () => {
  test("collects schemes across URL types, lower-cased and de-duplicated", () => {
    expect(urlSchemesFromInfoPlist({
      CFBundleURLTypes: [
        { CFBundleURLName: "main", CFBundleURLSchemes: ["MyApp", "myapp-dev"] },
        { CFBundleURLSchemes: ["myapp", "exp+my-app"] },
        { CFBundleURLSchemes: ["fb12345"] },
      ],
    })).toEqual(["myapp", "myapp-dev", "exp+my-app", "fb12345"]);
  });

  test("tolerates missing and odd shapes", () => {
    expect(urlSchemesFromInfoPlist(null)).toEqual([]);
    expect(urlSchemesFromInfoPlist({})).toEqual([]);
    expect(urlSchemesFromInfoPlist({ CFBundleURLTypes: "nope" })).toEqual([]);
    expect(urlSchemesFromInfoPlist({
      CFBundleURLTypes: [null, 3, {}, { CFBundleURLSchemes: null }, { CFBundleURLSchemes: [7, "", " ok "] }],
    })).toEqual(["ok"]);
    // A bare string instead of an array still counts.
    expect(urlSchemesFromInfoPlist({ CFBundleURLTypes: [{ CFBundleURLSchemes: "single" }] })).toEqual(["single"]);
  });

  test("drops values that aren't schemes", () => {
    expect(urlSchemesFromInfoPlist({
      CFBundleURLTypes: [{ CFBundleURLSchemes: ["1bad", "has space", "with://", "a_b", "good.app"] }],
    })).toEqual(["good.app"]);
  });
});

describe("displayNameFromInfoPlist", () => {
  test("prefers CFBundleDisplayName, then CFBundleName", () => {
    expect(displayNameFromInfoPlist({ CFBundleDisplayName: "Shown", CFBundleName: "Name" })).toBe("Shown");
    expect(displayNameFromInfoPlist({ CFBundleDisplayName: " ", CFBundleName: "Name" })).toBe("Name");
    expect(displayNameFromInfoPlist({})).toBeNull();
    expect(displayNameFromInfoPlist(null)).toBeNull();
  });
});

describe("applinksDomains", () => {
  test("keeps only applinks entries and strips ?mode= suffixes", () => {
    expect(applinksDomains([
      "applinks:example.com",
      "webcredentials:example.com",
      "applinks:beta.example.com?mode=developer",
      "activitycontinuation:example.com",
      "applinks:*.example.org",
      "APPLINKS:Example.com",
      "applinks:localhost:8443?mode=developer+managed",
    ])).toEqual(["example.com", "beta.example.com", "*.example.org", "localhost:8443"]);
  });

  test("ignores junk", () => {
    expect(applinksDomains(null)).toEqual([]);
    expect(applinksDomains("applinks:example.com")).toEqual([]);
    expect(applinksDomains([1, "applinks:", "applinks:bad domain", "applinks:a/b"])).toEqual([]);
  });
});

const ENTITLEMENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>application-identifier</key>
	<string>ABC.com.example</string>
	<key>com.apple.developer.associated-domains</key>
	<array>
		<string>applinks:example.com</string>
		<string>applinks:*.example.org?mode=developer</string>
		<string>webcredentials:a&amp;b.example.com</string>
	</array>
	<key>keychain-access-groups</key>
	<array><string>ABC.shared</string></array>
</dict>
</plist>
`;

describe("associatedDomainsFromEntitlementsXml", () => {
  test("reads the associated-domains array only", () => {
    expect(associatedDomainsFromEntitlementsXml(ENTITLEMENTS_XML)).toEqual([
      "applinks:example.com",
      "applinks:*.example.org?mode=developer",
      "webcredentials:a&b.example.com",
    ]);
  });

  test("handles codesign's single-line output and a missing key", () => {
    const oneLine = ENTITLEMENTS_XML.replace(/\n\s*/g, "");
    expect(applinksDomains(associatedDomainsFromEntitlementsXml(oneLine))).toEqual(["example.com", "*.example.org"]);
    expect(associatedDomainsFromEntitlementsXml("<plist><dict><key>get-task-allow</key><true/></dict></plist>")).toEqual([]);
    expect(associatedDomainsFromEntitlementsXml("")).toEqual([]);
  });
});

/** `otool -X -s __TEXT __entitlements` text for `text`: 16 bytes a line, LE words. */
function otoolWords(text: string, address = 0x10000038c): string {
  const bytes = [...Buffer.from(text, "utf8")];
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const groups: string[] = [];
    for (let w = off; w < Math.min(off + 16, bytes.length); w += 4) {
      const word = bytes.slice(w, Math.min(w + 4, bytes.length));
      groups.push(word.reverse().map((b) => b.toString(16).padStart(2, "0")).join(""));
    }
    lines.push(`${(address + off).toString(16).padStart(16, "0")}\t${groups.join(" ")} `);
  }
  return lines.join("\n") + "\n";
}

function otoolBytes(text: string, address: number): string {
  const bytes = [...Buffer.from(text, "utf8")];
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    lines.push(`${(address + off).toString(16).padStart(16, "0")}\t${bytes.slice(off, off + 16).map((b) => b.toString(16).padStart(2, "0")).join(" ")} `);
  }
  return lines.join("\n") + "\n";
}

describe("entitlementsTextFromOtool", () => {
  test("decodes a real arm64 line (little-endian words)", () => {
    // Captured from otool on a binary linked with -sectcreate __TEXT __entitlements.
    expect(entitlementsTextFromOtool("000000010000038c\t6d783f3c 6576206c 6f697372 31223d6e \n")).toBe('<?xml version="1');
  });

  test("round-trips a whole plist, including a partial last word", () => {
    const text = `${ENTITLEMENTS_XML}X`;
    expect(entitlementsTextFromOtool(otoolWords(text))).toBe(text);
    expect(applinksDomains(associatedDomainsFromEntitlementsXml(entitlementsTextFromOtool(otoolWords(ENTITLEMENTS_XML)))))
      .toEqual(["example.com", "*.example.org"]);
  });

  test("decodes byte-wise (x86_64) output", () => {
    expect(entitlementsTextFromOtool(otoolBytes(ENTITLEMENTS_XML, 0x10000039f))).toBe(ENTITLEMENTS_XML);
  });

  test("reads only the first slice of a fat binary", () => {
    const fat = otoolBytes("<plist>first</plist>", 0x10000039f) + otoolWords("<plist>second</plist>", 0x10000038c);
    expect(entitlementsTextFromOtool(fat)).toBe("<plist>first</plist>");
  });

  test("ignores headers, errors and trailing NULs", () => {
    expect(entitlementsTextFromOtool("/path/bin:\nContents of (__TEXT,__entitlements) section\n")).toBe("");
    expect(entitlementsTextFromOtool("64-bit Mach-O does not have a __TEXT,__entitlements\n")).toBe("");
    expect(entitlementsTextFromOtool(otoolBytes("ab\0\0", 0x1000))).toBe("ab");
  });
});

describe("readUniversalLinkDomains", () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-linking-"));
  const app = join(dir, "My App.app");
  mkdirSync(app);
  writeFileSync(join(app, "MyApp"), "binary");
  chmodSync(join(app, "MyApp"), 0o755);
  symlinkSync("/bin/ls", join(app, "Linked"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("merges codesign's entitlements with the __entitlements section", async () => {
    const calls: Array<[string, string[]]> = [];
    const domains = await readUniversalLinkDomains(app, { CFBundleExecutable: "MyApp" }, async (file, args) => {
      calls.push([file, args]);
      if (file === "codesign") {
        return { stdout: "<plist><dict><key>com.apple.developer.associated-domains</key><array><string>applinks:signed.example.com</string></array></dict></plist>", stderr: "", exitCode: 0 };
      }
      return { stdout: otoolWords(ENTITLEMENTS_XML), stderr: "", exitCode: 0 };
    });
    expect(domains).toEqual(["signed.example.com", "example.com", "*.example.org"]);
    expect(calls).toEqual([
      ["codesign", ["-d", "--entitlements", "-", "--xml", app]],
      ["otool", ["-X", "-s", "__TEXT", "__entitlements", join(app, "MyApp")]],
    ]);
  });

  test("skips the binary when the executable name is unsafe, missing or a symlink", async () => {
    for (const executable of ["../MyApp", "Missing", "Linked", "", undefined]) {
      const calls: string[] = [];
      const domains = await readUniversalLinkDomains(app, { CFBundleExecutable: executable }, async (file) => {
        calls.push(file);
        return { stdout: "", stderr: "code object is not signed", exitCode: 1 };
      });
      expect(domains).toEqual([]);
      expect(calls).toEqual(["codesign"]);
    }
  });
});
