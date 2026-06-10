import { describe, expect, test } from "bun:test";
import {
  buildRedirectResolveCommand,
  parseLocationInput,
} from "../client/location-input-parser";

describe("parseLocationInput — raw coordinates", () => {
  test("comma-separated lat,lng", () => {
    const r = parseLocationInput("37.7749,-122.4194");
    expect(r).toEqual({ kind: "coords", lat: 37.7749, lng: -122.4194 });
  });

  test("with whitespace", () => {
    const r = parseLocationInput("  37.7749 , -122.4194  ");
    expect(r).toEqual({ kind: "coords", lat: 37.7749, lng: -122.4194 });
  });

  test("space-separated", () => {
    const r = parseLocationInput("37.7749 -122.4194");
    expect(r).toEqual({ kind: "coords", lat: 37.7749, lng: -122.4194 });
  });

  test("integer values", () => {
    const r = parseLocationInput("0,0");
    expect(r).toEqual({ kind: "coords", lat: 0, lng: 0 });
  });

  test("rejects out-of-range latitude", () => {
    const r = parseLocationInput("100,0");
    expect(r.kind).toBe("error");
  });

  test("rejects out-of-range longitude", () => {
    const r = parseLocationInput("0,200");
    expect(r.kind).toBe("error");
  });

  test("empty input is an error", () => {
    expect(parseLocationInput("").kind).toBe("error");
    expect(parseLocationInput("   ").kind).toBe("error");
  });
});

describe("parseLocationInput — Google Maps", () => {
  test("long-form @lat,lng,zoom", () => {
    const r = parseLocationInput(
      "https://www.google.com/maps/@35.6586,139.7454,17z",
    );
    expect(r).toEqual({ kind: "coords", lat: 35.6586, lng: 139.7454 });
  });

  test("place URL with !3d!4d data block", () => {
    const r = parseLocationInput(
      "https://www.google.com/maps/place/Tokyo+Tower/@35.6585805,139.7434269,17z/data=!3m1!4b1!4m6!3m5!1s0x60188bbd9009ec09:0x481a93f0d2a409dd!8m2!3d35.6585805!4d139.7454329!16zL20vMDdwbWg2",
    );
    expect(r.kind).toBe("coords");
    if (r.kind === "coords") {
      expect(r.lat).toBeCloseTo(35.6585805, 5);
      expect(r.lng).toBeCloseTo(139.7454329, 5);
    }
  });

  test("?q=lat,lng query form", () => {
    const r = parseLocationInput("https://maps.google.com/?q=37.7749,-122.4194");
    expect(r).toEqual({ kind: "coords", lat: 37.7749, lng: -122.4194 });
  });

  test("?ll=lat,lng query form", () => {
    const r = parseLocationInput("https://maps.google.com/?ll=37.7749,-122.4194");
    expect(r).toEqual({ kind: "coords", lat: 37.7749, lng: -122.4194 });
  });

  test("?destination=lat,lng (directions)", () => {
    const r = parseLocationInput(
      "https://www.google.com/maps/dir/?api=1&destination=48.8584,2.2945",
    );
    expect(r).toEqual({ kind: "coords", lat: 48.8584, lng: 2.2945 });
  });

  test("country-TLD host", () => {
    const r = parseLocationInput("https://www.google.co.jp/maps/@35.6586,139.7454,17z");
    expect(r.kind).toBe("coords");
  });

  test("URL without scheme", () => {
    const r = parseLocationInput("maps.google.com/?q=37.7749,-122.4194");
    expect(r).toEqual({ kind: "coords", lat: 37.7749, lng: -122.4194 });
  });

  test("place URL with no coordinates → redirect", () => {
    const r = parseLocationInput("https://maps.google.com/?q=Tokyo+Tower");
    expect(r.kind).toBe("redirect");
  });
});

describe("parseLocationInput — Apple Maps", () => {
  test("?ll=lat,lng", () => {
    const r = parseLocationInput("https://maps.apple.com/?ll=35.6586,139.7454");
    expect(r).toEqual({ kind: "coords", lat: 35.6586, lng: 139.7454 });
  });

  test("?coordinate=lat,lng", () => {
    const r = parseLocationInput(
      "https://maps.apple.com/?coordinate=37.7749,-122.4194",
    );
    expect(r).toEqual({ kind: "coords", lat: 37.7749, lng: -122.4194 });
  });

  test("?q=lat,lng", () => {
    const r = parseLocationInput("https://maps.apple.com/?q=37.7749,-122.4194");
    expect(r).toEqual({ kind: "coords", lat: 37.7749, lng: -122.4194 });
  });

  test("address-only URL → redirect", () => {
    const r = parseLocationInput("https://maps.apple.com/?address=Tokyo+Tower");
    expect(r.kind).toBe("redirect");
  });
});

describe("parseLocationInput — short links", () => {
  test("maps.app.goo.gl returns redirect", () => {
    const r = parseLocationInput("https://maps.app.goo.gl/abcdef");
    expect(r).toEqual({
      kind: "redirect",
      url: "https://maps.app.goo.gl/abcdef",
    });
  });

  test("goo.gl returns redirect", () => {
    const r = parseLocationInput("https://goo.gl/maps/xyz");
    expect(r.kind).toBe("redirect");
  });
});

describe("parseLocationInput — invalid", () => {
  test("plain text returns error", () => {
    const r = parseLocationInput("hello world");
    expect(r.kind).toBe("error");
  });

  test("non-maps URL returns error", () => {
    const r = parseLocationInput("https://example.com/some/path");
    expect(r.kind).toBe("error");
  });
});

describe("buildRedirectResolveCommand", () => {
  test("wraps the URL in single quotes and follows redirects", () => {
    const cmd = buildRedirectResolveCommand("https://maps.app.goo.gl/abc");
    expect(cmd).toContain("curl");
    expect(cmd).toMatch(/-[sIL]*L/);
    expect(cmd).toContain("%{url_effective}");
    expect(cmd).toContain("'https://maps.app.goo.gl/abc'");
  });

  test("escapes embedded single quotes", () => {
    const cmd = buildRedirectResolveCommand("https://x.test/?q=it's");
    expect(cmd).toContain("'https://x.test/?q=it'\\''s'");
  });
});
