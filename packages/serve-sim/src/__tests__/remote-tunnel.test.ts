import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import {
  CLOUDFLARED_INSTALL_HINT,
  TunnelLogParser,
  formatTunnelBanner,
  generateAuthToken,
  normalizePublicOrigin,
  planTunnel,
  quickTunnelArgs,
  startQuickTunnel,
  tunnelOnListening,
  tunnelTargetUrl,
  type SpawnFn,
} from "../tunnel";

const TOKEN_ENV = "SERVE_SIM_AUTH_TOKEN";

// What cloudflared 2024–2026 prints on stderr for a quick tunnel.
const CLOUDFLARED_LOG = [
  "2026-11-24T18:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment. See https://developers.cloudflare.com/cloudflare-one/connections/connect-apps",
  "2026-11-24T18:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "2026-11-24T18:00:01Z INF +--------------------------------------------------------------------------------------------+",
  "2026-11-24T18:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
  "2026-11-24T18:00:01Z INF |  https://lucky-otter-river-blue.trycloudflare.com                                          |",
  "2026-11-24T18:00:01Z INF +--------------------------------------------------------------------------------------------+",
];

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: string[];
  kill(signal?: string): boolean;
}

function fakeSpawn(): { spawn: SpawnFn; calls: { command: string; args: readonly string[] }[]; child: () => FakeChild } {
  const calls: { command: string; args: readonly string[] }[] = [];
  let last: FakeChild | undefined;
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = [];
    child.kill = (signal = "SIGTERM") => {
      child.killed.push(signal);
      return true;
    };
    last = child;
    return child as unknown as ChildProcess;
  };
  return { spawn, calls, child: () => last! };
}

describe("token", () => {
  test("generateAuthToken is 32 random bytes as base64url", () => {
    const a = generateAuthToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateAuthToken()).not.toBe(a);
  });

  test("planTunnel generates a token and sets it on the existing auth env", () => {
    const env: NodeJS.ProcessEnv = {};
    const plan = planTunnel({ env, tokenEnv: TOKEN_ENV, findBin: () => "/opt/bin/cloudflared", newToken: () => "fresh" });
    expect(plan).toEqual({ token: "fresh", generated: true, publicOrigin: undefined, cloudflared: "/opt/bin/cloudflared" });
    expect(env[TOKEN_ENV]).toBe("fresh");
  });

  test("planTunnel keeps --auth-token / SERVE_SIM_AUTH_TOKEN", () => {
    const env: NodeJS.ProcessEnv = { [TOKEN_ENV]: " pinned " };
    const plan = planTunnel({ env, tokenEnv: TOKEN_ENV, findBin: () => "/c", newToken: () => "never" });
    expect(plan.token).toBe("pinned");
    expect(plan.generated).toBe(false);
    expect(planTunnel({ explicitToken: "flag", env: {}, tokenEnv: TOKEN_ENV, findBin: () => "/c" }).token).toBe("flag");
  });

  test("missing cloudflared fails with the brew hint", () => {
    expect(() => planTunnel({ env: {}, tokenEnv: TOKEN_ENV, findBin: () => undefined })).toThrow(CLOUDFLARED_INSTALL_HINT);
  });

  test("--public-origin skips the cloudflared lookup", () => {
    let looked = false;
    const plan = planTunnel({
      publicOrigin: "https://sim.example.com/",
      env: {},
      tokenEnv: TOKEN_ENV,
      findBin: () => { looked = true; return undefined; },
    });
    expect(looked).toBe(false);
    expect(plan.publicOrigin).toBe("https://sim.example.com");
    expect(plan.cloudflared).toBeUndefined();
  });
});

describe("origins", () => {
  test("normalizePublicOrigin accepts bare origins only", () => {
    expect(normalizePublicOrigin("https://a.trycloudflare.com/")).toBe("https://a.trycloudflare.com");
    expect(normalizePublicOrigin("http://mac.tailnet.ts.net:8080")).toBe("http://mac.tailnet.ts.net:8080");
    for (const bad of ["https://a.example/path", "https://a.example/?token=x", "ftp://a.example", "nope"]) {
      expect(() => normalizePublicOrigin(bad)).toThrow();
    }
  });

  test("the tunnel targets loopback for loopback / wildcard binds", () => {
    expect(tunnelTargetUrl("127.0.0.1", 3412)).toBe("http://127.0.0.1:3412");
    expect(tunnelTargetUrl("0.0.0.0", 3412)).toBe("http://127.0.0.1:3412");
    expect(tunnelTargetUrl("192.168.1.5", 3412)).toBe("http://192.168.1.5:3412");
    expect(tunnelTargetUrl("fe80::1", 3412)).toBe("http://[fe80::1]:3412");
  });
});

describe("cloudflared log parsing", () => {
  test("finds the quick tunnel URL in the banner, not the docs or api links", () => {
    const parser = new TunnelLogParser();
    const found = CLOUDFLARED_LOG.map((l) => parser.feed(l)).filter(Boolean);
    expect(found).toEqual(["https://lucky-otter-river-blue.trycloudflare.com"]);
    expect(new TunnelLogParser().feed("INF requesting https://api.trycloudflare.com/tunnel")).toBeUndefined();
  });

  test("falls back to the URL after 'Visit it at' if the domain changes", () => {
    const parser = new TunnelLogParser();
    expect(parser.feed("INF |  Your quick Tunnel has been created! Visit it at:  |")).toBeUndefined();
    expect(parser.feed("INF |  https://new-name.cfargotunnel.dev  |")).toBe("https://new-name.cfargotunnel.dev");
  });

  test("remembers the last error line", () => {
    const parser = new TunnelLogParser();
    parser.feed("2026-11-24T18:00:00Z ERR failed to request quick Tunnel: 429 Too Many Requests");
    expect(parser.error()).toContain("429 Too Many Requests");
  });
});

describe("startQuickTunnel", () => {
  test("spawns cloudflared with the loopback target and resolves the public origin", async () => {
    const fake = fakeSpawn();
    const pending = startQuickTunnel({ bin: "/opt/bin/cloudflared", targetUrl: "http://127.0.0.1:3412", spawn: fake.spawn });
    // Output arrives in arbitrary chunks on stderr.
    const text = CLOUDFLARED_LOG.join("\n") + "\n";
    fake.child().stderr.write(text.slice(0, 300));
    fake.child().stderr.write(text.slice(300));
    const tunnel = await pending;
    expect(fake.calls).toEqual([{ command: "/opt/bin/cloudflared", args: quickTunnelArgs("http://127.0.0.1:3412") }]);
    expect(fake.calls[0]!.args).toEqual(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3412"]);
    expect(tunnel.publicOrigin).toBe("https://lucky-otter-river-blue.trycloudflare.com");
    tunnel.stop();
    tunnel.stop();
    expect(fake.child().killed).toEqual(["SIGTERM"]);
  });

  test("rejects with cloudflared's error when it exits before printing a URL", async () => {
    const fake = fakeSpawn();
    const pending = startQuickTunnel({ bin: "/c", targetUrl: "http://127.0.0.1:1", spawn: fake.spawn });
    fake.child().stderr.write("2026-11-24T18:00:00Z ERR failed to request quick Tunnel: 500\n");
    await Bun.sleep(5);
    fake.child().emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/exited \(code 1\).*failed to request quick Tunnel: 500/);
  });

  test("a missing binary (ENOENT) rejects with the install hint", async () => {
    const fake = fakeSpawn();
    const pending = startQuickTunnel({ bin: "/nope/cloudflared", targetUrl: "http://127.0.0.1:1", spawn: fake.spawn });
    fake.child().emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await expect(pending).rejects.toThrow(CLOUDFLARED_INSTALL_HINT);
  });

  test("times out and kills cloudflared when no URL appears", async () => {
    const fake = fakeSpawn();
    const pending = startQuickTunnel({ bin: "/c", targetUrl: "http://127.0.0.1:1", spawn: fake.spawn, timeoutMs: 20 });
    await expect(pending).rejects.toThrow(/did not report a tunnel URL/);
    expect(fake.child().killed).toEqual(["SIGTERM"]);
  });

  test("reports a tunnel that dies after coming up, but not one we stopped", async () => {
    const fake = fakeSpawn();
    const lost: string[] = [];
    const pending = startQuickTunnel({ bin: "/c", targetUrl: "http://127.0.0.1:1", spawn: fake.spawn, onExit: (code) => lost.push(String(code)) });
    fake.child().stderr.write(CLOUDFLARED_LOG.join("\n") + "\n");
    await pending;
    fake.child().emit("exit", 1, null);
    expect(lost).toEqual(["1"]);

    const fake2 = fakeSpawn();
    const lost2: string[] = [];
    const p2 = startQuickTunnel({ bin: "/c", targetUrl: "http://127.0.0.1:1", spawn: fake2.spawn, onExit: (code) => lost2.push(String(code)) });
    fake2.child().stderr.write(CLOUDFLARED_LOG.join("\n") + "\n");
    (await p2).stop();
    fake2.child().emit("exit", null, "SIGTERM");
    expect(lost2).toEqual([]);
  });
});

describe("tunnelOnListening + banner", () => {
  test("--public-origin never spawns cloudflared and prints the connect recipe", async () => {
    const fake = fakeSpawn();
    const out: string[] = [];
    const hook = tunnelOnListening(
      { token: "tok_123", generated: true, publicOrigin: "https://sim.example.com" },
      { host: "127.0.0.1", log: (t) => out.push(t), onExit: () => {}, onTunnelLost: () => {}, spawn: fake.spawn },
    );
    await hook(3412);
    expect(fake.calls).toHaveLength(0);
    const text = out.join("\n");
    expect(text).toContain("http://localhost:3412");
    expect(text).toContain("https://sim.example.com/#token=tok_123");
    expect(text).toContain("export SERVE_SIM_AUTH_TOKEN=tok_123");
    expect(text).toContain("serve-sim connect https://sim.example.com");
    expect(text).not.toContain("?token=");
  });

  test("quick tunnel: stops cloudflared from the exit handler", async () => {
    const fake = fakeSpawn();
    const exitHandlers: (() => void)[] = [];
    const out: string[] = [];
    const hook = tunnelOnListening(
      { token: "tok", generated: false, cloudflared: "/opt/bin/cloudflared" },
      { host: "127.0.0.1", log: (t) => out.push(t), onExit: (h) => exitHandlers.push(h), onTunnelLost: () => {}, spawn: fake.spawn },
    );
    const pending = hook(3413);
    fake.child().stderr.write(CLOUDFLARED_LOG.join("\n") + "\n");
    await pending;
    expect(fake.calls[0]!.args).toContain("http://127.0.0.1:3413");
    expect(out.join("\n")).toContain("serve-sim connect https://lucky-otter-river-blue.trycloudflare.com");
    expect(exitHandlers).toHaveLength(1);
    exitHandlers[0]!();
    expect(fake.child().killed).toEqual(["SIGTERM"]);
  });

  test("formatTunnelBanner puts the token in the fragment only", () => {
    const text = formatTunnelBanner({ localUrl: "http://localhost:1", publicOrigin: "https://o.example", token: "T", generated: false, quick: false });
    expect(text).toContain("https://o.example/#token=T");
    expect(text).not.toMatch(/\?token=/);
  });
});
