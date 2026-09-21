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
}

/** Persistent RealityKit worker. At most one immutable JPEG is in flight. */
export class DuoRenderer {
  private readonly child: ChildProcessWithoutNullStreams;
  private bytes = Buffer.alloc(0);
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
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.bytes = Buffer.concat([this.bytes, chunk]);
      try {
        if (this.bytes.length < 4) return;
        const headerLength = this.bytes.readUInt32BE(0);
        if (headerLength < 1 || headerLength > 65536) throw new Error("Invalid Duo render header");
        if (this.bytes.length < 4 + headerLength) return;
        const header = JSON.parse(this.bytes.subarray(4, 4 + headerLength).toString()) as DuoProjection & { jpegLength: number };
        if (!Number.isInteger(header.jpegLength) || header.jpegLength < 1 || header.jpegLength > 32_000_000) throw new Error("Invalid Duo render frame");
        const end = 4 + headerLength + header.jpegLength;
        if (this.bytes.length < end) return;
        const jpeg = this.bytes.subarray(4 + headerLength, end);
        this.bytes = this.bytes.subarray(end);
        const pending = this.pending;
        this.pending = undefined;
        if (pending) {
          clearTimeout(pending.timer);
          const { jpegLength: _length, ...projection } = header;
          pending.resolve({ jpeg, projection });
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  render(jpeg: Uint8Array, panel: "cover" | "inner", hingeDegrees: number, rollDegrees: number): Promise<{ jpeg: Buffer; projection: DuoProjection }> {
    if (this.closed || this.pending) return Promise.reject(new Error("Duo renderer is unavailable or busy"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Duo renderer timed out")), 10000);
      this.pending = { resolve, reject, timer };
      const header = Buffer.from(JSON.stringify({ jpegLength: jpeg.length, panel, hingeDegrees, rollDegrees }));
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
