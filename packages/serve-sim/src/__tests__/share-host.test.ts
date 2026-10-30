import { describe, expect, test } from "bun:test";
import { shareHost } from "../share-host";

describe("shareHost", () => {
  const lan = (host: string, networkIP: string | null = "192.168.1.20") =>
    shareHost({ host, exposedToLan: true, networkIP });

  test("a specific --host address is the share host, not the LAN IP", () => {
    expect(lan("10.0.0.5")).toBe("10.0.0.5");
    expect(lan("100.101.102.103")).toBe("100.101.102.103");
    expect(lan("devbox.local")).toBe("devbox.local");
  });

  test("a wildcard bind uses the LAN IP", () => {
    for (const host of ["0.0.0.0", "::", "[::]", ""]) expect(lan(host)).toBe("192.168.1.20");
  });

  test("a wildcard bind with no LAN IP keeps the placeholder", () => {
    expect(lan("0.0.0.0", null)).toBe("<host>");
  });

  test("IPv6 addresses are bracketed", () => {
    expect(lan("fd00::1")).toBe("[fd00::1]");
    expect(lan("[fd00::1]")).toBe("[fd00::1]");
    expect(lan("::", "fe80::1")).toBe("[fe80::1]");
  });

  test("a loopback-only bind keeps the placeholder", () => {
    expect(shareHost({ host: "127.0.0.1", exposedToLan: false, networkIP: "192.168.1.20" })).toBe("<host>");
  });
});
