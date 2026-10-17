/**
 * Compile-and-cache for the bench's Swift helpers (native-probe.swift,
 * frame-decoder.swift).
 *
 * Binaries live in a per-user cache directory (created 0700 and checked to be
 * ours) under a name keyed by the SHA-256 of the source + compiler flags, so
 * editing a .swift file triggers a rebuild and nothing is ever executed from a
 * fixed, world-writable path like /tmp.
 */
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

const SWIFTC_FLAGS = ["-O"];

function benchCacheDir(): string {
  const root = process.env.XDG_CACHE_HOME
    ? process.env.XDG_CACHE_HOME
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : join(homedir(), ".cache");
  return join(root, "serve-sim-bench");
}

/** Create `dir` (0700) if needed and refuse to use it unless it's a real
 *  directory owned by the current user that nobody else can write to. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`bench cache ${dir} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`bench cache ${dir} is owned by uid ${st.uid}, not ${uid}`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function swiftHelperPath(source: string, cacheDir: string): string {
  const hash = createHash("sha256")
    .update(SWIFTC_FLAGS.join(" "))
    .update("\0")
    .update(readFileSync(source))
    .digest("hex")
    .slice(0, 16);
  return join(cacheDir, `${basename(source, ".swift")}-${hash}`);
}

type Compile = (source: string, out: string) => void;

const swiftc: Compile = (source, out) => {
  execFileSync("swiftc", [...SWIFTC_FLAGS, "-o", out, source], { stdio: "inherit" });
};

/** Path to an up-to-date binary for `source`, compiling it if needed. */
export function buildSwiftHelper(
  source: string,
  opts: { cacheDir?: string; compile?: Compile } = {},
): string {
  const cacheDir = opts.cacheDir ?? benchCacheDir();
  const compile = opts.compile ?? swiftc;
  ensurePrivateDir(cacheDir);
  const bin = swiftHelperPath(source, cacheDir);
  if (existsSync(bin)) {
    const st = lstatSync(bin);
    const uid = process.getuid?.();
    if (st.isFile() && (uid === undefined || st.uid === uid) && (st.mode & 0o022) === 0) return bin;
    rmSync(bin, { force: true });
  }
  // Compile beside the target and rename so a half-written binary is never
  // picked up by a concurrent or interrupted run.
  const tmp = `${bin}.tmp-${process.pid}`;
  try {
    compile(source, tmp);
    chmodSync(tmp, 0o700);
    renameSync(tmp, bin);
  } finally {
    rmSync(tmp, { force: true });
  }
  return bin;
}
