import { createDuoFrameParser } from "./duo-frame-parser";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Persistent RealityKit worker. At most one immutable JPEG is in flight. */
export class DuoRenderer {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (frame: { jpeg: Buffer; projection: DuoProjection }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private closed = false;

  constructor() {
    const relative = join("simduo", "serve-sim-duo-render");
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const executable = [join(dirname(process.execPath), relative), join(moduleDir, relative), join(moduleDir, "..", "dist", relative)].find(existsSync);
    if (!executable) throw new Error("Duo renderer is missing. Rebuild serve-sim.");
    const developer = process.env.DEVELOPER_DIR ?? execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim();
    const model = join(developer, "..", "SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz");
    if (!existsSync(model)) throw new Error("The selected Xcode does not include the iPhone Duo 3D model.");
    this.child = spawn(executable, [model], { stdio: "pipe" });
    this.child.stderr.on("data", (data) => console.error("[duo-renderer]", data.toString().trim()));
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", () => this.fail(new Error("Duo renderer exited")));
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
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  /** `fullResolution` remains on the worker protocol. Native preview ignores it and always renders 1000×900. */
  render(jpeg: Uint8Array, panel: "cover" | "inner", hingeDegrees: number, rollDegrees: number, fullResolution = false): Promise<{ jpeg: Buffer; projection: DuoProjection }> {
    if (this.closed || this.pending) return Promise.reject(new Error("Duo renderer is unavailable or busy"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Duo renderer timed out")), 10000);
      this.pending = { resolve, reject, timer };
      const header = Buffer.from(JSON.stringify({ jpegLength: jpeg.length, panel, hingeDegrees, rollDegrees, fullResolution }));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(header.length);
      // Copy native frame storage before its callback returns and it is reused.
      this.child.stdin.write(Buffer.concat([prefix, header, jpeg]));
    });
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.close();
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
