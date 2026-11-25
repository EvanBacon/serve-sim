import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer, get } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { stripVTControlCharacters } from "util";
import {
  formatInstallBanner,
  installCommand,
  installJson,
  parseTtl,
  prepareIpa,
  type InstallCommandDeps,
  type InstallCommandOptions,
} from "../install-command";
import type { IpaInfo } from "../install-ipa";
import { installUrls } from "../install-server";
import { makeIpa } from "./install-fixtures";

const dir = mkdtempSync(join(tmpdir(), "install-command-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseTtl", () => {
  test("units and bare minutes", () => {
    expect(parseTtl("30m")).toBe(30 * 60_000);
    expect(parseTtl("2h")).toBe(2 * 3_600_000);
    expect(parseTtl("90s")).toBe(90_000);
    expect(parseTtl("1h30m")).toBe(90 * 60_000);
    expect(parseTtl("15")).toBe(15 * 60_000);
    expect(parseTtl(" 1.5h ")).toBe(90 * 60_000);
  });
  test("rejects nonsense, zero and more than 24h", () => {
    for (const bad of ["", "abc", "0", "0m", "-5m", "25h", "10d", "5 m", "m"]) expect(parseTtl(bad)).toBeNull();
    expect(parseTtl("24h")).toBe(24 * 3_600_000);
  });
});

describe("prepareIpa", () => {
  test("an .ipa file is used as is", () => {
    const p = join(dir, "a.ipa");
    writeFileSync(p, "x");
    const prepared = prepareIpa(p);
    expect(prepared.ipaPath).toBe(p);
    prepared.cleanup();
  });
  test("errors", () => {
    expect(() => prepareIpa(join(dir, "missing.ipa"))).toThrow(/No such file/);
    const plainDir = join(dir, "folder");
    mkdirSync(plainDir);
    expect(() => prepareIpa(plainDir)).toThrow(/Not an .ipa/);
    const app = join(dir, "X.app");
    mkdirSync(app);
    expect(() => prepareIpa(app, "linux")).toThrow(/needs macOS/);
    const archive = join(dir, "X.xcarchive");
    mkdirSync(join(archive, "Products", "Applications"), { recursive: true });
    expect(() => prepareIpa(archive, "linux")).toThrow(/found 0/);
  });
});

const info: IpaInfo = {
  appName: "OTA Test",
  bundleId: "com.example.app",
  version: "1.0",
  build: "7",
  appDir: "Payload/OTATest.app/",
  signed: true,
  profile: {
    kind: "development",
    name: "Dev",
    teamName: "Example Team",
    teamId: "ABCDE12345",
    expiresAt: "2026-11-29T08:26:34.000Z",
    expired: false,
    applicationIdentifier: "ABCDE12345.com.example.app",
    bundleIdMatches: true,
    getTaskAllow: true,
    devices: ["D1", "D2", "D3", "D4", "D5"],
  },
  warnings: [],
};
const urls = installUrls("https://x.trycloudflare.com", "CAPCAP", false);
const strip = stripVTControlCharacters;

describe("banner", () => {
  test("text banner", () => {
    const out = strip(formatInstallBanner({ info, urls, expiresAt: 1_800_000, now: 0, once: true, quick: true, qr: "QR", udid: undefined }));
    expect(out).toContain("OTA Test 1.0 (7)");
    expect(out).toContain("Bundle:   com.example.app");
    expect(out).toContain("Signing:  Development profile, team Example Team (ABCDE12345), expires 2026-11-29");
    expect(out).toContain("5 provisioned: D1, D2, D3 (+2 more)");
    expect(out).toContain("xcrun devicectl list devices");
    expect(out).toContain(`- Page:     ${urls.page}`);
    expect(out).toContain(`- Direct:   ${urls.itms}`);
    expect(out).toContain("(in 30m), or after one download");
    expect(out).toContain("Ctrl+C to stop");
    expect(out).not.toMatch(/token/i);
  });

  test("--udid not included", () => {
    const out = strip(formatInstallBanner({ info, urls, expiresAt: 60_000, now: 0, once: false, quick: false, qr: "QR", udid: { udid: "ZZZ", status: "not-included" } }));
    expect(out).toContain("UDID:     ZZZ NOT included");
    expect(out).not.toContain("quick tunnel");
  });

  test("--udid on an unsigned build", () => {
    const unsigned = { ...info, signed: false, profile: undefined };
    const out = strip(formatInstallBanner({ info: unsigned, urls, expiresAt: 60_000, now: 0, once: false, quick: false, qr: "QR", udid: { udid: "ZZZ", status: "no-profile" } }));
    expect(out).toContain("Signing:  unsigned");
    expect(out).toContain("UDID:     ZZZ unknown (no provisioning profile)");
  });

  test("json has full device list, urls, expiry and warnings", () => {
    const j = installJson({ info: { ...info, warnings: ["w"] }, urls, expiresAt: 0, once: false }) as any;
    expect(j.app).toEqual({ name: "OTA Test", bundleId: "com.example.app", version: "1.0", build: "7", signed: true, hasIcon: false });
    expect(j.profile.devices).toEqual(["D1", "D2", "D3", "D4", "D5"]);
    expect(j.urls.itms).toBe(urls.itms);
    expect(j.expiresAt).toBe("1970-01-01T00:00:00.000Z");
    expect(j.warnings).toEqual(["w"]);
  });
});

describe("installCommand lifecycle", () => {
  const ipaPath = join(dir, "lifecycle.ipa");
  writeFileSync(ipaPath, makeIpa());
  const SIGNALS = ["SIGINT", "SIGTERM", "exit"] as const;
  const listenerCounts = () => SIGNALS.map((s) => process.listenerCount(s));

  function freePort(): Promise<number> {
    return new Promise((ok) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const { port } = s.address() as { port: number };
        s.close(() => ok(port));
      });
    });
  }

  function httpGet(port: number, path: string): Promise<{ status: number; body: Buffer }> {
    return new Promise((ok, fail) => {
      get({ host: "127.0.0.1", port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode!, body: Buffer.concat(chunks) }));
      }).on("error", fail);
    });
  }

  const tick = () => new Promise((r) => setTimeout(r, 5));

  async function run(opts: InstallCommandOptions, extra: Partial<InstallCommandDeps> = {}) {
    const port = opts.port ?? (await freePort());
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const h = { port, timers, out, err, tunnelStops: 0, tunnelStarts: 0, cleanups: 0, onExit: undefined as undefined | ((code: number | null, signal: NodeJS.Signals | null) => void) };
    const deps: InstallCommandDeps = {
      findOnPath: () => "/fake/cloudflared",
      prepareIpa: (input) => ({ ipaPath: input, cleanup: () => { h.cleanups++; } }),
      startQuickTunnel: async (o) => {
        h.tunnelStarts++;
        const stop = () => { h.tunnelStops++; };
        o.onSpawn?.(stop);
        h.onExit = o.onExit;
        return { publicOrigin: "https://fake-tunnel.trycloudflare.com", child: {} as ChildProcess, stop };
      },
      setTimer: (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return () => { t.cancelled = true; };
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      ...extra,
    };
    const done = installCommand(ipaPath, { json: true, ...opts, port }, deps);
    // Wait for the JSON line (activation) or an early exit.
    let settled = false;
    void done.then(() => { settled = true; });
    for (let i = 0; i < 200 && out.length === 0 && !settled; i++) await tick();
    const json = out[0] ? JSON.parse(out[0]) : undefined;
    const fire = (ms: number) => {
      const t = timers.find((x) => x.ms === ms && !x.cancelled);
      if (!t) throw new Error(`no live ${ms}ms timer`);
      t.fn();
    };
    return { h, done, json, fire, localPath: (url: string) => new URL(url).pathname };
  }

  test("--once revokes at once but keeps the tunnel up for the grace period", async () => {
    const before = listenerCounts();
    const { h, done, json, fire, localPath } = await run({ once: true });
    const ipa = await httpGet(h.port, localPath(json.urls.ipa));
    expect(ipa.status).toBe(200);
    await tick();
    expect(h.err).toContain("  Downloaded once; link revoked. Exiting in 60s (Ctrl+C to exit now).");
    expect(h.tunnelStops).toBe(0);
    expect((await httpGet(h.port, localPath(json.urls.ipa))).status).toBe(404);
    expect((await httpGet(h.port, localPath(json.urls.page))).status).toBe(404);
    expect(h.tunnelStops).toBe(0);

    fire(60_000);
    expect(await done).toBe(0);
    expect(h.tunnelStops).toBe(1);
    expect(h.cleanups).toBe(1);
    expect(listenerCounts()).toEqual(before);
    expect(h.timers.every((t) => t.cancelled || t.ms === 60_000)).toBe(true);
  });

  test("expiry shuts down once and removes the process listeners", async () => {
    const before = listenerCounts();
    const { h, done, fire } = await run({ ttl: "5m" });
    expect(listenerCounts()).toEqual(before.map((n) => n + 1));
    fire(5 * 60_000);
    expect(await done).toBe(0);
    expect(h.err).toContain("  Link expired. Stopped.");
    expect(h.tunnelStops).toBe(1);
    expect(h.cleanups).toBe(1);
    expect(listenerCounts()).toEqual(before);
  });

  test("cloudflared exiting shuts down with 1; later triggers don't clean up again", async () => {
    const before = listenerCounts();
    const { h, done, fire } = await run({});
    h.onExit!(null, "SIGKILL");
    expect(await done).toBe(1);
    expect(h.err.join("\n")).toMatch(/cloudflared exited \(SIGKILL\)/);
    expect(() => fire(30 * 60_000)).toThrow(/no live/); // expiry timer was cancelled
    h.onExit!(1, null);
    expect(h.tunnelStops).toBe(1);
    expect(h.cleanups).toBe(1);
    expect(listenerCounts()).toEqual(before);
  });

  test("a port in use returns 1 without starting the tunnel", async () => {
    const before = listenerCounts();
    const busy = createServer();
    const port = await freePort();
    await new Promise<void>((r) => busy.listen(port, "127.0.0.1", () => r()));
    try {
      const { h, done } = await run({ port });
      expect(await done).toBe(1);
      expect(h.err.join("\n")).toMatch(new RegExp(`Port ${port} is already in use`));
      expect(h.tunnelStarts).toBe(0);
      expect(h.cleanups).toBe(1);
      expect(listenerCounts()).toEqual(before);
    } finally {
      await new Promise<void>((r) => busy.close(() => r()));
    }
  });

  test("a tunnel that fails to start returns 1 and cleans up once", async () => {
    const before = listenerCounts();
    const { h, done } = await run({}, {
      startQuickTunnel: async () => { throw new Error("cloudflared did not report a tunnel URL within 30s"); },
    });
    expect(await done).toBe(1);
    expect(h.err.join("\n")).toMatch(/did not report a tunnel URL/);
    expect(h.cleanups).toBe(1);
    expect(listenerCounts()).toEqual(before);
  });
});
