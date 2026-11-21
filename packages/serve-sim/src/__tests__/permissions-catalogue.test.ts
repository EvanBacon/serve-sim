import { describe, expect, test } from "bun:test";
import {
  PERMISSION_SERVICES,
  permissionStatuses,
  requestedPermissions,
} from "../client/utils/permissions";
import {
  buildListResult,
  locationAuthorizationFromPlistXml,
  parsePermissionsArgs,
  parsePlistXml,
} from "../permissions";

const CATALOGUE = [
  "camera", "microphone", "photos", "photos-add", "contacts", "calendar", "reminders",
  "location", "location-always", "notifications", "motion", "media-library", "siri",
  "speech", "faceid", "user-tracking", "homekit",
];

describe("PERMISSION_SERVICES", () => {
  test("lists every CLI permission in catalogue order", () => {
    expect(PERMISSION_SERVICES.map((s) => s.key)).toEqual(CATALOGUE);
  });

  test("grant, revoke and reset accept every catalogue key", () => {
    for (const key of CATALOGUE) {
      for (const verb of ["grant", "revoke", "reset"]) {
        expect(parsePermissionsArgs([verb, key, "com.foo.bar"])).not.toHaveProperty("error");
      }
    }
  });
});

describe("requestedPermissions", () => {
  const d = "Because.";

  test("maps each single-key usage description", () => {
    expect(
      requestedPermissions({
        NSCameraUsageDescription: d,
        NSMicrophoneUsageDescription: d,
        NSPhotoLibraryUsageDescription: d,
        NSPhotoLibraryAddUsageDescription: d,
        NSContactsUsageDescription: d,
        NSMotionUsageDescription: d,
        NSAppleMusicUsageDescription: d,
        NSSiriUsageDescription: d,
        NSSpeechRecognitionUsageDescription: d,
        NSFaceIDUsageDescription: d,
        NSUserTrackingUsageDescription: d,
        NSHomeKitUsageDescription: d,
      }),
    ).toEqual([
      "camera", "microphone", "photos", "photos-add", "contacts", "motion", "media-library",
      "siri", "speech", "faceid", "user-tracking", "homekit",
    ]);
  });

  test("calendar and reminders accept legacy and iOS 17 keys", () => {
    for (const k of [
      "NSCalendarsUsageDescription",
      "NSCalendarsFullAccessUsageDescription",
      "NSCalendarsWriteOnlyAccessUsageDescription",
    ]) expect(requestedPermissions({ [k]: d })).toEqual(["calendar"]);
    for (const k of ["NSRemindersUsageDescription", "NSRemindersFullAccessUsageDescription"]) {
      expect(requestedPermissions({ [k]: d })).toEqual(["reminders"]);
    }
  });

  test("when-in-use keys request location only; always keys request both", () => {
    expect(requestedPermissions({ NSLocationWhenInUseUsageDescription: d })).toEqual(["location"]);
    expect(requestedPermissions({ NSLocationUsageDescription: d })).toEqual(["location"]);
    expect(requestedPermissions({ NSLocationAlwaysAndWhenInUseUsageDescription: d })).toEqual([
      "location",
      "location-always",
    ]);
    expect(requestedPermissions({ NSLocationAlwaysUsageDescription: d })).toEqual([
      "location",
      "location-always",
    ]);
  });

  test("notifications come from the remote-notification background mode", () => {
    expect(requestedPermissions({ UIBackgroundModes: ["audio", "remote-notification"] })).toEqual([
      "notifications",
    ]);
    expect(requestedPermissions({ UIBackgroundModes: ["audio"] })).toEqual([]);
    expect(requestedPermissions({ UIBackgroundModes: "remote-notification" })).toEqual([]);
  });

  test("ignores junk input and non-string or empty values", () => {
    for (const junk of [null, undefined, 42, "x", [], [{ NSCameraUsageDescription: d }]]) {
      expect(requestedPermissions(junk)).toEqual([]);
    }
    expect(
      requestedPermissions({
        NSCameraUsageDescription: "",
        NSMicrophoneUsageDescription: "   ",
        NSContactsUsageDescription: true,
        NSPhotoLibraryUsageDescription: { a: 1 },
        CFBundleIdentifier: "com.foo",
      }),
    ).toEqual([]);
  });
});

describe("permissionStatuses", () => {
  test("TCC auth values: 2 granted, 0 denied, 3 limited, other/absent unset", () => {
    const s = permissionStatuses({
      tcc: { camera: 2, microphone: 0, photos: 3, contacts: 1, siri: "2" },
      location: null,
      notifications: null,
    });
    expect(s.camera).toBe("granted");
    expect(s.microphone).toBe("denied");
    expect(s.photos).toBe("limited");
    expect(s.contacts).toBe("unset");
    expect(s.siri).toBe("unset");
    expect(s.calendar).toBe("unset");
  });

  test("location authorization", () => {
    const loc = (Authorization?: number) =>
      permissionStatuses({ tcc: {}, location: Authorization === undefined ? null : { Authorization } });
    expect([loc(2).location, loc(2)["location-always"]]).toEqual(["granted", "unset"]);
    expect([loc(4).location, loc(4)["location-always"]]).toEqual(["granted", "granted"]);
    expect([loc(1).location, loc(1)["location-always"]]).toEqual(["denied", "denied"]);
    expect([loc().location, loc()["location-always"]]).toEqual(["unset", "unset"]);
    expect([loc(0).location, loc(3)["location-always"]]).toEqual(["unset", "unset"]);
  });

  test("notifications", () => {
    const n = (v: unknown) => permissionStatuses({ notifications: v }).notifications;
    expect(n({ allowsNotifications: true, critical: false })).toBe("granted");
    expect(n({ allowsNotifications: false, critical: false })).toBe("denied");
    expect(n(null)).toBe("unset");
  });

  test("covers every catalogue key, even for junk", () => {
    for (const raw of [null, "x", { tcc: [] }]) {
      const s = permissionStatuses(raw);
      expect(Object.keys(s)).toEqual(CATALOGUE);
      expect(new Set(Object.values(s))).toEqual(new Set(["unset"]));
    }
  });
});

const CLIENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>MigrationVersionNumber</key>
\t<real>26</real>
\t<key>icom.foo.app:</key>
\t<dict>
\t\t<key>BundleId</key>
\t\t<string>com.foo.app</string>
\t\t<key>Blob</key>
\t\t<data>
\t\tAAEC
\t\t</data>
\t\t<key>Nested</key>
\t\t<dict><key>Authorization</key><integer>9</integer></dict>
\t\t<key>Tombstones</key>
\t\t<array><false/><true/></array>
\t\t<key>Empty</key>
\t\t<dict/>
\t</dict>
\t<key>icom.foo.app.later:</key>
\t<dict>
\t\t<key>Authorization</key>
\t\t<integer>4</integer>
\t</dict>
\t<key>icom.bar.app:</key>
\t<dict>
\t\t<key>Name</key>
\t\t<string>A &amp; B &lt;x&gt;</string>
\t\t<key>Authorization</key>
\t\t<integer>2</integer>
\t</dict>
</dict>
</plist>
`;

describe("clients.plist parsing", () => {
  test("parsePlistXml builds nested values", () => {
    const root = parsePlistXml(CLIENTS_XML) as any;
    expect(root.MigrationVersionNumber).toBe(26);
    expect(root["icom.foo.app:"].Tombstones).toEqual([false, true]);
    expect(root["icom.foo.app:"].Empty).toEqual({});
    expect(root["icom.foo.app:"].Blob.trim()).toBe("AAEC");
    expect(root["icom.bar.app:"].Name).toBe("A & B <x>");
  });

  test("reads Authorization from the app's own entry", () => {
    expect(locationAuthorizationFromPlistXml(CLIENTS_XML, "com.bar.app")).toBe(2);
    expect(locationAuthorizationFromPlistXml(CLIENTS_XML, "com.foo.app.later")).toBe(4);
  });

  test("does not bleed into a nested dict or a later app's entry", () => {
    expect(locationAuthorizationFromPlistXml(CLIENTS_XML, "com.foo.app")).toBeNull();
  });

  test("absent app or garbage input is null", () => {
    expect(locationAuthorizationFromPlistXml(CLIENTS_XML, "com.missing")).toBeNull();
    expect(locationAuthorizationFromPlistXml("", "com.foo.app")).toBeNull();
    expect(locationAuthorizationFromPlistXml("<plist><array/></plist>", "com.foo.app")).toBeNull();
  });
});

describe("buildListResult", () => {
  const raw = {
    tcc: { camera: 2, photos: 3 },
    location: { Authorization: 4 },
    notifications: { allowsNotifications: false, critical: false },
  };

  test("with a bundle id adds statuses and requested", () => {
    const out = buildListResult("U", "com.foo", raw, { NSCameraUsageDescription: "x" });
    expect(out).toMatchObject({ udid: "U", bundleId: "com.foo", ...raw, requested: ["camera"] });
    expect((out as any).statuses).toMatchObject({
      camera: "granted",
      photos: "limited",
      location: "granted",
      "location-always": "granted",
      notifications: "denied",
      microphone: "unset",
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  test("requested is null when Info.plist can't be read", () => {
    expect(buildListResult("U", "com.foo", raw, null)).toMatchObject({ requested: null });
  });

  test("without a bundle id keeps the original shape", () => {
    const out = buildListResult("U", undefined, { tcc: {}, location: null, notifications: null }, undefined);
    expect(out).toEqual({ udid: "U", bundleId: null, tcc: {}, location: null, notifications: null });
  });
});
