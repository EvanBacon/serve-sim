import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadRemoteProfile,
  normalizeRemoteUrl,
  remoteProfilePath,
  removeRemoteProfile,
  resolveRemoteUrl,
  saveRemoteProfile,
} from "../remote-profile";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "serve-sim-profile-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("remoteProfilePath", () => {
  test("uses $XDG_CONFIG_HOME when absolute", () => {
    expect(remoteProfilePath({ XDG_CONFIG_HOME: "/x/cfg", HOME: "/home/u" })).toBe("/x/cfg/serve-sim/remote.json");
  });
  test("falls back to ~/.config, ignoring a relative XDG_CONFIG_HOME", () => {
    expect(remoteProfilePath({ HOME: "/home/u" })).toBe("/home/u/.config/serve-sim/remote.json");
    expect(remoteProfilePath({ XDG_CONFIG_HOME: "rel", HOME: "/home/u" })).toBe("/home/u/.config/serve-sim/remote.json");
  });
});

describe("normalizeRemoteUrl", () => {
  test("strips the trailing slash and keeps a base path", () => {
    expect(normalizeRemoteUrl("https://a.trycloudflare.com/")).toBe("https://a.trycloudflare.com");
    expect(normalizeRemoteUrl(" https://host.example/sim/ ")).toBe("https://host.example/sim");
  });
  test("refuses tokens in the URL, credentials, and other schemes", () => {
    expect(() => normalizeRemoteUrl("https://a.example/?token=secret")).toThrow(/never in the URL/);
    expect(() => normalizeRemoteUrl("https://a.example/#token=secret")).toThrow(/never in the URL/);
    expect(() => normalizeRemoteUrl("https://user:pw@a.example")).toThrow(/credentials/);
    expect(() => normalizeRemoteUrl("ftp://a.example")).toThrow(/scheme/);
    expect(() => normalizeRemoteUrl("not a url")).toThrow(/Invalid URL/);
  });
});

describe("save / load / remove", () => {
  test("stores only the URL and savedAt, 0600 in a 0700 directory", () => {
    const path = join(tempDir(), "cfg", "serve-sim", "remote.json");
    const token = "super-secret-token-value";
    process.env.SERVE_SIM_AUTH_TOKEN = token;
    try {
      saveRemoteProfile("https://a.trycloudflare.com/", path, new Date("2026-01-02T03:04:05Z"));
    } finally {
      delete process.env.SERVE_SIM_AUTH_TOKEN;
    }
    const text = readFileSync(path, "utf8");
    expect(JSON.parse(text)).toEqual({ url: "https://a.trycloudflare.com", savedAt: "2026-01-02T03:04:05.000Z" });
    expect(text).not.toContain(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(loadRemoteProfile(path)?.url).toBe("https://a.trycloudflare.com");
    expect(removeRemoteProfile(path)?.url).toBe("https://a.trycloudflare.com");
    expect(loadRemoteProfile(path)).toBeUndefined();
    expect(removeRemoteProfile(path)).toBeUndefined();
  });

  test("a missing or corrupt profile loads as undefined", () => {
    const path = join(tempDir(), "remote.json");
    expect(loadRemoteProfile(path)).toBeUndefined();
    writeFileSync(path, "{not json");
    expect(loadRemoteProfile(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ url: "javascript:alert(1)" }));
    expect(loadRemoteProfile(path)).toBeUndefined();
  });
});

describe("resolveRemoteUrl order: --url > SERVE_SIM_URL > profile > local", () => {
  const profile = () => ({ url: "https://profile.example", savedAt: "" });
  test("--url wins", () => {
    expect(resolveRemoteUrl({ flag: "https://flag.example", env: { SERVE_SIM_URL: "https://env.example" }, profile })).toEqual({
      url: "https://flag.example",
      source: "flag",
    });
  });
  test("then SERVE_SIM_URL", () => {
    expect(resolveRemoteUrl({ env: { SERVE_SIM_URL: "https://env.example" }, profile })).toEqual({ url: "https://env.example", source: "env" });
  });
  test("then the saved profile", () => {
    expect(resolveRemoteUrl({ flag: " ", env: { SERVE_SIM_URL: "" }, profile })).toEqual({ url: "https://profile.example", source: "profile" });
  });
  test("else local (undefined)", () => {
    expect(resolveRemoteUrl({ env: {}, profile: () => undefined })).toBeUndefined();
  });
});
