import { describe, expect, test } from "bun:test";
import {
  allPermissionNames,
  parsePermissionsArgs,
  resolvePermission,
} from "../permissions";

describe("resolvePermission", () => {
  test("notifications resolves to the BulletinBoard writer", () => {
    expect(resolvePermission("notifications")).toEqual({
      kind: "notifications",
      values: ["critical"],
    });
  });

  test("location resolves with the three authorization levels", () => {
    expect(resolvePermission("location")).toEqual({
      kind: "location",
      values: ["always", "inuse", "never"],
    });
  });

  test("camera maps to its TCC service", () => {
    expect(resolvePermission("camera")).toEqual({
      kind: "tcc",
      tccService: "kTCCServiceCamera",
      tccAuthVersion: 1,
      values: undefined,
    });
  });

  test("photos uses auth_version 2 and accepts limited", () => {
    expect(resolvePermission("photos")).toEqual({
      kind: "tcc",
      tccService: "kTCCServicePhotos",
      tccAuthVersion: 2,
      values: ["limited"],
    });
  });

  test("contacts maps to the AddressBook service", () => {
    expect(resolvePermission("contacts")?.tccService).toBe("kTCCServiceAddressBook");
  });

  test("unknown permission returns null", () => {
    expect(resolvePermission("telepathy")).toBeNull();
  });
});

describe("allPermissionNames", () => {
  test("includes notifications, location and the TCC set", () => {
    const names = allPermissionNames();
    expect(names).toContain("notifications");
    expect(names).toContain("location");
    expect(names).toContain("camera");
    expect(names).toContain("media-library");
  });
});

describe("parsePermissionsArgs", () => {
  test("grant camera with a bundle id", () => {
    expect(parsePermissionsArgs(["grant", "camera", "com.foo.bar"])).toEqual({
      verb: "grant",
      permission: "camera",
      value: undefined,
      bundleId: "com.foo.bar",
      device: undefined,
    });
  });

  test("deny is an alias for revoke", () => {
    const parsed = parsePermissionsArgs(["deny", "camera", "com.foo.bar"]);
    expect("error" in parsed).toBe(false);
    expect((parsed as any).verb).toBe("revoke");
  });

  test("--value is parsed and validated against the permission", () => {
    expect(
      parsePermissionsArgs(["grant", "location", "com.foo.bar", "--value", "always"]),
    ).toMatchObject({ permission: "location", value: "always" });
  });

  test("location-always alias pins the value", () => {
    expect(
      parsePermissionsArgs(["grant", "location-always", "com.foo.bar"]),
    ).toMatchObject({ permission: "location", value: "always" });
  });

  test("trailing positional is accepted as the value", () => {
    expect(
      parsePermissionsArgs(["grant", "photos", "com.foo.bar", "limited"]),
    ).toMatchObject({ permission: "photos", value: "limited" });
  });

  test("push is an alias for notifications", () => {
    expect(
      parsePermissionsArgs(["grant", "push", "com.foo.bar"]),
    ).toMatchObject({ permission: "notifications" });
  });

  test("-d device flag is captured", () => {
    expect(
      parsePermissionsArgs(["grant", "camera", "com.foo.bar", "-d", "iPhone 16"]),
    ).toMatchObject({ device: "iPhone 16" });
  });

  test("reset all only needs a bundle id", () => {
    expect(parsePermissionsArgs(["reset", "all", "com.foo.bar"])).toEqual({
      verb: "reset",
      permission: "all",
      bundleId: "com.foo.bar",
      device: undefined,
    });
  });

  test("list with no bundle id is allowed", () => {
    expect(parsePermissionsArgs(["list"])).toEqual({
      verb: "list",
      bundleId: undefined,
      device: undefined,
    });
  });

  test("missing subcommand is an error", () => {
    expect(parsePermissionsArgs([])).toEqual({
      error: expect.stringContaining("Missing subcommand"),
    });
  });

  test("unknown subcommand is an error", () => {
    expect(parsePermissionsArgs(["frobnicate", "camera", "com.foo"])).toEqual({
      error: expect.stringContaining("Unknown subcommand"),
    });
  });

  test("unknown permission is an error", () => {
    expect(parsePermissionsArgs(["grant", "telepathy", "com.foo"])).toEqual({
      error: expect.stringContaining("Unknown permission"),
    });
  });

  test("missing bundle id is an error", () => {
    expect(parsePermissionsArgs(["grant", "camera"])).toEqual({
      error: expect.stringContaining("Missing bundle id"),
    });
  });

  test("invalid bundle id is rejected", () => {
    expect(parsePermissionsArgs(["grant", "camera", "com.foo bar"])).toEqual({
      error: expect.stringContaining("Invalid bundle id"),
    });
  });

  test("a --value that the permission does not support is rejected", () => {
    expect(
      parsePermissionsArgs(["grant", "camera", "com.foo.bar", "--value", "limited"]),
    ).toEqual({ error: expect.stringContaining("Invalid --value") });
  });

  test("an invalid location value is rejected", () => {
    expect(
      parsePermissionsArgs(["grant", "location", "com.foo.bar", "--value", "sometimes"]),
    ).toEqual({ error: expect.stringContaining("Invalid --value") });
  });
});
