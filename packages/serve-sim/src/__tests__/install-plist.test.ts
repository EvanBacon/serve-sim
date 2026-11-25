import { describe, expect, test } from "bun:test";
import { extractProvisionPlist, parseBinaryPlist, parsePlist, parseXmlPlist } from "../install-plist";
import { mobileprovision } from "./install-fixtures";

// `plutil -convert binary1` of a small Info.plist, plus a <date> and <data>
// inserted with `plutil -insert`, so the bytes come from Apple's writer.
const BPLIST_B64 =
  "YnBsaXN0MDDeAQIDBAUGBwgJCgsMDQ4PEBESExUWFxgZGhscIl8QE0NGQnVuZGxlRGlzcGxheU5hbWVUV2hlbl8QGkNGQnVuZGxlU2hvcnRWZXJzaW9uU3RyaW5nXxAPQ0ZCdW5kbGVWZXJzaW9uXxAcVUlSZXF1aXJlZERldmljZUNhcGFiaWxpdGllc18QEkNGQnVuZGxlSWRlbnRpZmllclxDRkJ1bmRsZU5hbWVSUGlTQmlnXxASTFNSZXF1aXJlc0lQaG9uZU9TVEJsb2JTTmVnXUNGQnVuZGxlSWNvbnNVQ291bnRvEBIA3ABuAO8AYwBvAGQAZQAgAMQAcABwACAAJgAgADwAQwBvAD4zQceDtpKAAABVMS4yLjNSNDWhFFVhcm02NF8QD2NvbS5leGFtcGxlLmFwcFNBcHAjQAwAAAAAAAATAAAAASoF8gAJQwABAhP/////////+dEdHl8QE0NGQnVuZGxlUHJpbWFyeUljb27RHyBfEBFDRkJ1bmRsZUljb25GaWxlc6EhXEFwcEljb242MHg2MBEBLAAIACUAOwBAAF0AbwCOAKMAsACzALcAzADRANUA4wDpARABGQEfASIBJAEqATwBQAFJAVIBUwFXAWABYwF5AXwBkAGSAZ8AAAAAAAACAQAAAAAAAAAjAAAAAAAAAAAAAAAAAAABog==";

describe("XML plist", () => {
  test("parses every value type, entities, comments and empty elements", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- a comment -->
<plist version="1.0">
<dict>
  <key>Name</key><string>A &amp; B &lt;c&gt; &quot;q&quot; &#233;&#x1F600;</string>
  <key>Empty</key><string/>
  <key>Int</key><integer>-42</integer>
  <key>Huge</key><integer>123456789012345678901</integer>
  <key>Real</key><real>2.5</real>
  <key>Yes</key><true/>
  <key>No</key><false/>
  <key>When</key><date>2026-11-24T10:00:00Z</date>
  <key>Bytes</key><data>
    AAEC
    /w==
  </data>
  <key>List</key><array><string>x</string><array/><dict/></array>
  <key>Nested</key><dict><key>Deep</key><dict><key>k</key><string>v</string></dict></dict>
</dict>
</plist>`;
    const v = parseXmlPlist(xml) as Record<string, unknown>;
    expect(v.Name).toBe('A & B <c> "q" é😀');
    expect(v.Empty).toBe("");
    expect(v.Int).toBe(-42);
    expect(v.Huge).toBe(123456789012345678901n);
    expect(v.Real).toBe(2.5);
    expect(v.Yes).toBe(true);
    expect(v.No).toBe(false);
    expect((v.When as Date).toISOString()).toBe("2026-11-24T10:00:00.000Z");
    expect([...(v.Bytes as Buffer)]).toEqual([0, 1, 2, 255]);
    expect(v.List).toEqual(["x", [], {}]);
    expect((v.Nested as any).Deep.k).toBe("v");
  });

  test("rejects malformed input", () => {
    expect(() => parseXmlPlist("<plist><dict><key>a</key>")).toThrow();
    expect(() => parseXmlPlist("<html></html>")).toThrow(/missing <plist>/);
    expect(() => parseXmlPlist("<plist><dict><string>no key</string></dict></plist>")).toThrow(/expected <key>/);
    expect(() => parseXmlPlist("<plist><bogus/></plist>")).toThrow(/unknown element/);
  });

  test("keys like __proto__ don't pollute prototypes", () => {
    const v = parseXmlPlist("<plist><dict><key>__proto__</key><dict><key>polluted</key><true/></dict></dict></plist>");
    expect(({} as any).polluted).toBeUndefined();
    expect((v as any).__proto__.polluted).toBe(true);
  });
});

describe("binary plist", () => {
  test("parses plutil output", () => {
    const buf = Buffer.from(BPLIST_B64, "base64");
    const v = parsePlist(buf) as Record<string, any>;
    expect(v.CFBundleIdentifier).toBe("com.example.app");
    expect(v.CFBundleDisplayName).toBe("Ünïcode Äpp & <Co>"); // UTF-16 string
    expect(v.CFBundleShortVersionString).toBe("1.2.3");
    expect(v.CFBundleVersion).toBe("45");
    expect(v.LSRequiresIPhoneOS).toBe(true);
    expect(v.UIRequiredDeviceCapabilities).toEqual(["arm64"]);
    expect(v.Count).toBe(300);
    expect(v.Big).toBe(5000000000);
    expect(v.Neg).toBe(-7);
    expect(v.Pi).toBe(3.5);
    expect(v.CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconFiles).toEqual(["AppIcon60x60"]);
    expect((v.When as Date).toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect([...(v.Blob as Buffer)]).toEqual([0, 1, 2]);
  });

  test("rejects truncated or corrupt data without hanging", () => {
    const buf = Buffer.from(BPLIST_B64, "base64");
    expect(() => parseBinaryPlist(buf.subarray(0, 20))).toThrow();
    const bad = Buffer.from(buf);
    bad.writeBigUInt64BE(9999n, bad.length - 8); // offset table past the end
    expect(() => parseBinaryPlist(bad)).toThrow();
  });

  test("detects reference cycles", () => {
    // bplist00, object 0 = array [ref 0], offset table, trailer.
    const body = Buffer.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 0xa1, 0x00, 0x08]);
    const trailer = Buffer.alloc(32);
    trailer[6] = 1; // offset int size
    trailer[7] = 1; // object ref size
    trailer.writeBigUInt64BE(1n, 8);
    trailer.writeBigUInt64BE(0n, 16);
    trailer.writeBigUInt64BE(10n, 24);
    expect(() => parseBinaryPlist(Buffer.concat([body, trailer]))).toThrow(/cycle/);
  });
});

test("binary plist: shared references can't expand exponentially", () => {
  // 30 arrays, each [next, next]: 2^30 visits if expanded naively.
  const header = Buffer.from("bplist00", "latin1");
  const objects: Buffer[] = [];
  for (let i = 0; i < 30; i++) objects.push(i < 29 ? Buffer.from([0xa2, i + 1, i + 1]) : Buffer.from([0x08]));
  const offsets: number[] = [];
  let at = header.length;
  for (const o of objects) { offsets.push(at); at += o.length; }
  const table = Buffer.from(offsets);
  const trailer = Buffer.alloc(32);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  expect(() => parseBinaryPlist(Buffer.concat([header, ...objects, table, trailer]))).toThrow(/too many objects/);
});

describe("embedded.mobileprovision", () => {
  test("extracts the XML plist from the CMS blob", () => {
    const p = extractProvisionPlist(mobileprovision({ devices: ["UDID-1"], getTaskAllow: true }));
    expect(p.Name).toBe("Test Profile");
    expect(p.ProvisionedDevices).toEqual(["UDID-1"]);
    expect((p.Entitlements as any)["get-task-allow"]).toBe(true);
  });

  test("fails clearly without a plist", () => {
    expect(() => extractProvisionPlist(Buffer.from([0x30, 0x82, 0, 0]))).toThrow(/no plist/);
  });
});
