import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { SimulatorOrientation } from "./client/types";

export function parseHingeSample(line: string): number | null {
  if (!/AngleValid:Y\b/.test(line)) return null;
  const match = /\bAngle:\s*(-?[\d.]+)°/.exec(line);
  const angle = match ? Number(match[1]) : NaN;
  return Number.isFinite(angle) && angle >= 0 && angle <= 180 ? angle : null;
}

export function parseIntegratedScreenOrientations(text: string): Partial<Record<"cover" | "inner", SimulatorOrientation>> {
  const result: Partial<Record<"cover" | "inner", SimulatorOrientation>> = {};
  const names: Record<string, SimulatorOrientation> = {
    Portrait: "portrait", "Portrait Upside Down": "portrait_upside_down",
    "Landscape Left": "landscape_left", "Landscape Right": "landscape_right",
  };
  for (const block of text.split(/(?=^\s*\(\d+\)[^\n]*:)/m)) {
    if (!/^\s*Screen Type:\s*Integrated\s*$/m.test(block)) continue;
    const name = /^\s*Device Name:\s*(\S+)/m.exec(block)?.[1];
    const orientation = names[/^\s*UI Orientation:\s*([^\r\n]+)/m.exec(block)?.[1]?.trim() ?? ""];
    if (!orientation) continue;
    if (name === "primary") result.cover = orientation;
    if (name === "primary-1") result.inner = orientation;
  }
  return result;
}

/** SpringBoard keeps the current primary panel through intermediate folds. */
export function parsePrimaryPanel(line: string): "cover" | "inner" | null {
  if (!/\[(?:com\.apple\.SpringBoard:)?DisplayContentMode\]/.test(line)) return null;
  if (/\.cover:pri\b/.test(line)) return "cover";
  if (/\.inner:pri\b/.test(line)) return "inner";
  return null;
}

export interface DuoState {
  hingeDegrees?: number;
  primaryPanel?: "cover" | "inner";
  orientations: Partial<Record<"cover" | "inner", SimulatorOrientation>>;
}

/** One shared monitor per device session; phones never start these processes. */
export class DuoStateMonitor {
  private stopped = false;
  private monitor?: ChildProcess;
  private enumeration?: ChildProcess;
  private panelMonitor?: ChildProcess;
  private panelSeed?: ChildProcess;
  private panelRetry?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setTimeout>;
  private state: DuoState = { orientations: {} };

  constructor(private readonly udid: string, private readonly onState: (state: DuoState) => void) {
    this.watchPanels();
    this.watchHinge();
    this.refreshOrientation();
  }

  refreshOrientation(): void {
    if (this.stopped || this.enumeration) return;
    if (this.poll) clearTimeout(this.poll);
    this.enumeration = execFile("/usr/bin/xcrun", ["simctl", "io", this.udid, "enumerate"],
      { timeout: 3000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        this.enumeration = undefined;
        if (this.stopped) return;
        if (!error) {
          const orientations = parseIntegratedScreenOrientations(stdout);
          if (JSON.stringify(orientations) !== JSON.stringify(this.state.orientations)) {
            this.state = { ...this.state, orientations };
            this.onState(this.state);
          }
        }
        this.poll = setTimeout(() => this.refreshOrientation(), 1000);
        this.poll.unref();
      });
  }

  private watchPanels(): void {
    if (this.stopped) return;
    const predicate = 'process == "SpringBoard" AND category == "DisplayContentMode" AND (eventMessage CONTAINS ".cover:pri" OR eventMessage CONTAINS ".inner:pri")';
    let liveSample = false;
    const accept = (line: string) => {
      const primaryPanel = parsePrimaryPanel(line);
      if (!primaryPanel || this.stopped) return;
      if (primaryPanel === this.state.primaryPanel) return;
      this.state = { ...this.state, primaryPanel };
      this.onState(this.state);
      this.refreshOrientation();
    };
    const child = spawn("/usr/bin/xcrun", ["simctl", "spawn", this.udid, "log", "stream", "--style", "compact", "--predicate", predicate], { stdio: ["ignore", "pipe", "ignore"] });
    this.panelMonitor = child;
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!.slice(-4096);
      for (const line of lines) {
        if (parsePrimaryPanel(line)) liveSample = true;
        accept(line);
      }
    });
    // Seed from this boot's most recent transition, then let live events win.
    this.panelSeed = execFile("/usr/bin/xcrun", ["simctl", "spawn", this.udid, "log", "show", "--last", "boot", "--style", "compact", "--predicate", predicate],
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        this.panelSeed = undefined;
        if (!error && !liveSample) {
          const last = stdout.split("\n").reverse().find((line) => parsePrimaryPanel(line));
          if (last) accept(last);
        }
      });
    child.on("error", () => {});
    child.once("close", () => {
      if (this.panelMonitor === child) this.panelMonitor = undefined;
      if (this.stopped) return;
      this.panelRetry = setTimeout(() => this.watchPanels(), 1000);
      this.panelRetry.unref();
    });
  }

  private watchHinge(): void {
    if (this.stopped) return;
    const child = spawn("/usr/bin/xcrun", ["devicectl", "device", "motion", "hinge-angle", "--device", this.udid,
      "--session-timeout", "60", "--timeout", "65", "--change-threshold", "0.5"], { stdio: ["ignore", "pipe", "ignore"] });
    this.monitor = child;
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!.slice(-4096);
      for (const line of lines) {
        const hingeDegrees = parseHingeSample(line);
        if (this.stopped || hingeDegrees == null || hingeDegrees === this.state.hingeDegrees) continue;
        this.state = { ...this.state, hingeDegrees };
        this.onState(this.state);
        this.refreshOrientation();
      }
    });
    child.on("error", () => {}); // close also fires for failed spawns; retry there.
    child.once("close", () => {
      if (this.monitor === child) this.monitor = undefined;
      if (this.stopped) return;
      this.retry = setTimeout(() => this.watchHinge(), 1000);
      this.retry.unref();
    });
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.panelRetry);
    this.panelMonitor?.kill();
    this.panelSeed?.kill();
    clearTimeout(this.retry);
    clearTimeout(this.poll);
    this.monitor?.kill();
    this.enumeration?.kill();
  }
}
