import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostRpcHandler, type RunResult } from "../host-rpc";

const UDID = "11111111-2222-3333-4444-555555555555";
const NAME = "serve-sim-recording-2026-11-11-12-30-00.mp4";

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "serve-sim-rec-home-")));
  mkdirSync(join(home, "Downloads"));
  mkdirSync(join(home, "Desktop"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function handler(mdfind: RunResult = { stdout: "", stderr: "", exitCode: 0 }) {
  const calls: Array<[string, string[]]> = [];
  const rpc = createHostRpcHandler({
    serveSimBin: "serve-sim",
    homeDir: home,
    isKnownDevice: async () => true,
    run: async (file, args): Promise<RunResult> => {
      calls.push([file, args]);
      if (file === "mdfind") return mdfind;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  return { rpc, calls };
}

describe("locateRecording", () => {
  test("finds the download in ~/Downloads without asking Spotlight", async () => {
    const path = join(home, "Downloads", NAME);
    writeFileSync(path, "mp4");
    const { rpc, calls } = handler();
    expect(await rpc({ method: "locateRecording", params: { fileName: NAME } })).toEqual({ path });
    expect(calls).toEqual([]);
  });

  test("falls back to ~/Desktop, then Spotlight under home", async () => {
    const elsewhere = join(home, "Movies");
    mkdirSync(elsewhere);
    const path = join(elsewhere, NAME);
    writeFileSync(path, "mp4");
    const { rpc, calls } = handler({ stdout: `/etc/${NAME}\n${path}\n`, stderr: "", exitCode: 0 });
    expect(await rpc({ method: "locateRecording", params: { fileName: NAME } })).toEqual({ path });
    expect(calls).toEqual([["mdfind", ["-onlyin", home, `kMDItemFSName == "${NAME}"`]]]);
  });

  test("returns an empty path when the file isn't there yet", async () => {
    const { rpc } = handler();
    expect(await rpc({ method: "locateRecording", params: { fileName: NAME } })).toEqual({ path: "" });
  });

  test("rejects names that aren't toolbar recordings", async () => {
    const { rpc, calls } = handler();
    for (const fileName of ["../x.mp4", "serve-sim-recording-x.mov", 'serve-sim-recording-" || x.mp4', 42]) {
      await expect(rpc({ method: "locateRecording", params: { fileName } })).rejects.toThrow(/invalid fileName/);
    }
    expect(calls).toEqual([]);
  });
});

describe("revealRecording", () => {
  test("reveals a recording under home in Finder", async () => {
    const path = join(home, "Downloads", NAME);
    writeFileSync(path, "mp4");
    const { rpc, calls } = handler();
    expect(await rpc({ method: "revealRecording", params: { path } })).toMatchObject({ exitCode: 0 });
    expect(calls).toEqual([["open", ["-R", path]]]);
  });

  test("refuses paths outside home, unnormalized, misnamed, missing, or symlinked", async () => {
    const real = join(home, "Downloads", NAME);
    writeFileSync(real, "mp4");
    const link = join(home, "Desktop", NAME);
    symlinkSync(real, link);
    const { rpc, calls } = handler();
    const bad = [
      `/tmp/${NAME}`,
      `${home}/Downloads/../Downloads/${NAME}`,
      join(home, "Downloads", "serve-sim-screenshot-1.png"),
      join(home, "Movies", NAME),
      link,
      `${home}-evil/${NAME}`,
    ];
    for (const path of bad) {
      await expect(rpc({ method: "revealRecording", params: { path } })).rejects.toThrow(/invalid path|recording not found/);
    }
    expect(calls).toEqual([]);
  });
});

describe("addMedia", () => {
  test("accepts a downloaded recording dragged from the toast", async () => {
    const path = join(home, "Downloads", NAME);
    writeFileSync(path, "mp4");
    const { rpc, calls } = handler();
    await rpc({ method: "addMedia", params: { udid: UDID, path } });
    expect(calls).toEqual([["xcrun", ["simctl", "addmedia", UDID, path]]]);
  });
});
