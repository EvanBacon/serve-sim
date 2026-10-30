import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { createHostRpcHandler, type RunResult } from "../host-rpc";
import { resolveServeSimBin } from "../middleware";
import { reExecArgs, selfServeSimBin } from "../self-bin";

const UDID = "11111111-2222-3333-4444-555555555555";

describe("reExecArgs / selfServeSimBin", () => {
  test("node running the JS bundle re-execs node with the script", () => {
    const proc = { argv: ["/usr/bin/node", "/pkg/dist/serve-sim.js", "x"], execPath: "/usr/bin/node" };
    expect(reExecArgs(["--port", "1"], proc)).toEqual({
      command: "/usr/bin/node",
      args: ["/pkg/dist/serve-sim.js", "--port", "1"],
    });
    expect(selfServeSimBin(proc)).toBe("/pkg/dist/serve-sim.js");
  });

  test("argv[0] naming the serve-sim binary is used directly", () => {
    const proc = { argv: ["/opt/bin/serve-sim", "x"], execPath: "/opt/bin/serve-sim" };
    expect(reExecArgs(["a"], proc)).toEqual({ command: "/opt/bin/serve-sim", args: ["a"] });
    expect(selfServeSimBin(proc)).toBe("/opt/bin/serve-sim");
  });

  test("a bun --compile binary never yields a /$bunfs path", () => {
    // What a compiled binary actually reports: argv[0] is "bun".
    const proc = { argv: ["bun", "/$bunfs/root/serve-sim", "x"], execPath: "/usr/local/bin/serve-sim" };
    expect(reExecArgs(["a"], proc)).toEqual({ command: "/usr/local/bin/serve-sim", args: ["a"] });
    expect(selfServeSimBin(proc)).toBe("/usr/local/bin/serve-sim");
  });
});

describe("resolveServeSimBin (embedded middleware default)", () => {
  const root = mkdtempSync(join(tmpdir(), "serve-sim-bin-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("ignores the host app's argv and resolves the package's own dist entry", () => {
    const dist = join(root, "pkg", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "serve-sim.js"), "");
    const originalArgv1 = process.argv[1];
    process.argv[1] = join(root, "host-app", "server.js");
    try {
      expect(resolveServeSimBin(pathToFileURL(join(dist, "middleware.js")).href)).toBe(join(dist, "serve-sim.js"));
    } finally {
      process.argv[1] = originalArgv1!;
    }
  });

  test("from src/ in a checkout, uses the sibling dist entry", () => {
    const src = join(root, "pkg", "src");
    mkdirSync(src, { recursive: true });
    expect(resolveServeSimBin(pathToFileURL(join(src, "middleware.ts")).href)).toBe(
      join(root, "pkg", "src", "..", "dist", "serve-sim.js"),
    );
  });

  test("falls back to serve-sim on PATH when no entry exists (e.g. /$bunfs)", () => {
    expect(resolveServeSimBin("file:///$bunfs/root/serve-sim", () => false)).toBe("serve-sim");
    expect(resolveServeSimBin("not a url")).toBe("serve-sim");
  });
});

describe("appDetails Info.plist", () => {
  const root = mkdtempSync(join(tmpdir(), "serve-sim-app-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function handlerFor(appPath: string) {
    const calls: Array<[string, string[]]> = [];
    const handler = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => true,
      run: async (file, args): Promise<RunResult> => {
        calls.push([file, args]);
        if (file === "xcrun") return { stdout: `${appPath}\n`, stderr: "", exitCode: 0 };
        if (file === "plutil") return { stdout: JSON.stringify({ CFBundleName: "Real" }), stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    return { handler, calls };
  }

  test("a regular Info.plist is read with plutil", async () => {
    const app = join(root, "Real.app");
    mkdirSync(app);
    writeFileSync(join(app, "Info.plist"), "");
    const { handler, calls } = handlerFor(app);
    const result = await handler({ method: "appDetails", params: { udid: UDID, bundleId: "com.x" } });
    expect(result.displayName).toBe("Real");
    expect(calls.some(([file]) => file === "plutil")).toBe(true);
  });

  test("a symlinked Info.plist is not passed to plutil", async () => {
    const app = join(root, "Linked.app");
    mkdirSync(app);
    writeFileSync(join(root, "secret.plist"), "");
    symlinkSync(join(root, "secret.plist"), join(app, "Info.plist"));
    const { handler, calls } = handlerFor(app);
    const result = await handler({ method: "appDetails", params: { udid: UDID, bundleId: "com.x" } });
    expect(result.appPath).toBe(app);
    expect(result.displayName).toBeUndefined();
    expect(calls.some(([file]) => file === "plutil")).toBe(false);
  });

  test("a missing Info.plist is not passed to plutil", async () => {
    const app = join(root, "Empty.app");
    mkdirSync(app);
    const { handler, calls } = handlerFor(app);
    await handler({ method: "appDetails", params: { udid: UDID, bundleId: "com.x" } });
    expect(calls.some(([file]) => file === "plutil")).toBe(false);
  });
});
