import { createDuoFrameParser } from "./duo-frame-parser";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactHome } from "./diagnostics-redact";

export interface DuoProjection {
  width: number;
  height: number;
  panel: "cover" | "inner";
  hingeDegrees: number;
  /** Four projected raw-buffer corners followed by [u, v, width, height]. */
  pieces: number[][][];
  /** Projected physical button centers and clockwise edge tangent, in key order. */
  hardware?: { x: number; y: number; angle: number }[];
}

/** Where a Duo 3D preview failed. Returned to the browser as the 503 `stage`. */
export type DuoRendererStage =
  | "worker_missing"
  | "developer_dir"
  | "model_lookup"
  | "worker_spawn"
  | "worker_exit"
  | "protocol"
  | "timeout"
  | "first_frame";

/** A Duo renderer failure with a stage and JSON-safe details for the 503 body, logs, and event log. */
export class DuoRendererError extends Error {
  constructor(
    readonly stage: DuoRendererStage,
    readonly reason: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(reason);
    this.name = "DuoRendererError";
  }
}

const RELATIVE_MODEL = "SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz";
const STDERR_TAIL_BYTES = 2048;

/** The Duo model path for one Xcode Developer dir (`…/Xcode.app/Contents/Developer`). */
export function duoModelPath(developerDir: string): string {
  return join(developerDir, "..", RELATIVE_MODEL);
}

export type DuoModelLookup = {
  developerDir: string | null;
  source: "DEVELOPER_DIR" | "xcode-select";
  modelPath: string | null;
  exists: boolean;
  error?: string;
};

/** Resolve the model exactly as the renderer does: DEVELOPER_DIR, else `xcode-select -p`. */
export function resolveDuoModel(
  env: NodeJS.ProcessEnv = process.env,
  xcodeSelect: () => string = () => execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 5000 }).trim(),
  exists: (path: string) => boolean = existsSync,
): DuoModelLookup {
  const source = env.DEVELOPER_DIR ? "DEVELOPER_DIR" : "xcode-select";
  let developerDir: string;
  try {
    developerDir = env.DEVELOPER_DIR ?? xcodeSelect();
  } catch (error) {
    return { developerDir: null, source, modelPath: null, exists: false, error: error instanceof Error ? error.message : String(error) };
  }
  const modelPath = duoModelPath(developerDir);
  return { developerDir, source, modelPath, exists: exists(modelPath) };
}

export function resolveDuoRendererExecutable(): string | null {
  const relative = join("simduo", "serve-sim-duo-render");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return [join(dirname(process.execPath), relative), join(moduleDir, relative), join(moduleDir, "..", "dist", relative)].find(existsSync) ?? null;
}

const loggedFailures = new Set<string>();

/** Log each distinct renderer failure once, with everything needed to act on it. */
export function logDuoRendererFailure(error: DuoRendererError, log: (line: string) => void = console.error): boolean {
  const key = `${error.stage}\u0000${error.reason}`;
  if (loggedFailures.has(key)) return false;
  loggedFailures.add(key);
  const details = redactHome(error.details);
  const extra = Object.entries(details)
    .filter(([, value]) => value != null && value !== "")
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(" ");
  log(`[duo-renderer] ${error.stage} failed: ${redactHome(error.reason)}${extra ? ` (${extra})` : ""}`);
  return true;
}

export function resetDuoRendererFailureLogForTests(): void {
  loggedFailures.clear();
}

/** Persistent RealityKit worker. At most one immutable JPEG is in flight. */
export class DuoRenderer {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (frame: { jpeg: Buffer; projection: DuoProjection }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private closed = false;
  private stderrTail = "";
  readonly modelPath: string;

  /** Throws `DuoRendererError` for setup failures; later failures go to `onFailure` and any pending render. */
  constructor(private readonly onFailure?: (error: DuoRendererError) => void) {
    const executable = resolveDuoRendererExecutable();
    if (!executable) throw new DuoRendererError("worker_missing", "Duo renderer is missing. Rebuild serve-sim.");
    const lookup = resolveDuoModel();
    if (!lookup.developerDir || !lookup.modelPath) {
      throw new DuoRendererError("developer_dir", "Could not resolve the selected Xcode (xcode-select -p failed).", { source: lookup.source, error: lookup.error });
    }
    if (!lookup.exists) {
      throw new DuoRendererError("model_lookup", "The selected Xcode does not include the iPhone Duo 3D model.", {
        model_path: lookup.modelPath,
        developer_dir: lookup.developerDir,
        source: lookup.source,
      });
    }
    this.modelPath = lookup.modelPath;
    this.child = spawn(executable, [lookup.modelPath], { stdio: "pipe" });
    this.child.stderr.on("data", (data) => {
      const text = data.toString();
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES);
      console.error("[duo-renderer]", text.trim());
    });
    this.child.on("error", (error: NodeJS.ErrnoException) => this.fail(new DuoRendererError("worker_spawn", `Duo renderer could not start: ${error.message}`, {
      executable, code: error.code, model_path: this.modelPath,
    })));
    this.child.stdin.on("error", (error) => this.fail(new DuoRendererError("worker_exit", `Duo renderer input closed: ${error.message}`, this.exitDetails())));
    this.child.on("exit", (code, signal) => this.fail(new DuoRendererError("worker_exit", "Duo renderer exited", this.exitDetails(code, signal))));
    const parser = createDuoFrameParser((frame) => {
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(frame);
      }
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { parser.push(chunk); }
      catch (error) { this.fail(new DuoRendererError("protocol", `Duo renderer sent a malformed frame: ${error instanceof Error ? error.message : String(error)}`, this.exitDetails())); }
    });
  }

  /** `fullResolution` selects the one-shot 1500×1350 settle target. Motion passes false (1000×900). */
  render(jpeg: Uint8Array, panel: "cover" | "inner", hingeDegrees: number, rollDegrees: number, fullResolution = false): Promise<{ jpeg: Buffer; projection: DuoProjection }> {
    if (this.closed || this.pending) return Promise.reject(new Error("Duo renderer is unavailable or busy"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new DuoRendererError("timeout", "Duo renderer timed out after 10s", {
        ...this.exitDetails(), jpeg_bytes: jpeg.length, panel, hinge_degrees: hingeDegrees,
      })), 10000);
      this.pending = { resolve, reject, timer };
      const header = Buffer.from(JSON.stringify({ jpegLength: jpeg.length, panel, hingeDegrees, rollDegrees, fullResolution }));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(header.length);
      // Copy native frame storage before its callback returns and it is reused.
      this.child.stdin.write(Buffer.concat([prefix, header, jpeg]));
    });
  }

  private exitDetails(code?: number | null, signal?: NodeJS.Signals | null): Record<string, unknown> {
    return {
      model_path: this.modelPath,
      ...(code !== undefined ? { exit_code: code } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(this.stderrTail ? { stderr_tail: this.stderrTail.trim() } : {}),
    };
  }

  private fail(error: DuoRendererError): void {
    if (this.closed) return;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.close();
    this.onFailure?.(error);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Duo renderer closed")); }
  }
}
