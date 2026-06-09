/**
 * Real-device (physical iPhone/iPad) support via WebDriverAgent (WDA).
 *
 * serve-sim's native helper streams the *simulator* framebuffer over private
 * CoreSimulator/SimulatorKit APIs and injects input over the simulator's
 * synthetic-touch socket. None of that exists for a physical device. The only
 * mechanism Apple ships that gives us BOTH a live screen and synthetic input on
 * a real device is an XCUITest runner — i.e. WebDriverAgent, the same thing
 * Appium drives.
 *
 * This module owns the WDA lifecycle for a single connected device:
 *   1. detect the device over usbmux (`pymobiledevice3 usbmux list`),
 *   2. launch the prebuilt WebDriverAgentRunner via `xcodebuild
 *      test-without-building` (it stays alive and hosts an HTTP control server
 *      on device port 8100 + an MJPEG server on 9100),
 *   3. forward those two ports to localhost over usbmux,
 *   4. health-check `:8100/status`, open a WDA session, and read the device's
 *      logical window size (used to map normalized 0..1 touch coords to points).
 *
 * The actual screen relay + input translation lives in `device-server.ts`; this
 * file is purely "make WDA reachable and give me a typed client for it".
 *
 * Building/signing WebDriverAgentRunner onto the device is an inherently
 * per-user Xcode operation (it needs your Apple Development identity and a
 * 7-day free-provisioning cert), so it's a one-time prerequisite rather than
 * something we do silently on every run. If the build product is missing we
 * attempt a build when a team id is resolvable, otherwise we print the exact
 * command to run.
 */
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { debugDevice } from "./debug";

/** A physical iOS device visible over usbmux. */
export interface RealDevice {
  udid: string;
  name: string;
  /** Marketing-ish product type, e.g. "iPhone17,1". */
  productType: string;
  /** iOS version string, e.g. "26.5". */
  productVersion: string;
}

export interface WdaConfig {
  /** Checkout of appium/WebDriverAgent. */
  wdaDir: string;
  /** Apple Developer Team ID (10-char) used to sign the runner. */
  teamId?: string;
  /** Bundle id for the runner. Must be unique to the signing team. */
  bundleId: string;
  /** Local port mapped to WDA's on-device control server (8100). */
  controlPort: number;
  /** Local port mapped to WDA's on-device MJPEG server (9100). */
  mjpegPort: number;
}

const DEFAULT_WDA_DIR = join(homedir(), ".serve-sim-device", "WebDriverAgent");
const WDA_DEVICE_CONTROL_PORT = 8100;
const WDA_DEVICE_MJPEG_PORT = 9100;

/** Locate the `pymobiledevice3` CLI (pipx installs it under ~/.local/bin). */
export function findPymobiledevice3(): string | null {
  const candidates = [
    join(homedir(), ".local", "bin", "pymobiledevice3"),
    "/opt/homebrew/bin/pymobiledevice3",
    "/usr/local/bin/pymobiledevice3",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to PATH lookup.
  try {
    const found = execFileSync("command", ["-v", "pymobiledevice3"], {
      encoding: "utf-8",
      shell: "/bin/bash",
    }).trim();
    if (found) return found;
  } catch {}
  return null;
}

/** List physical iOS devices connected over USB. */
export function listRealDevices(): RealDevice[] {
  const pmd = findPymobiledevice3();
  if (!pmd) return [];
  try {
    const out = execFileSync(pmd, ["usbmux", "list"], {
      encoding: "utf-8",
      timeout: 8_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const data = JSON.parse(out) as Array<{
      ConnectionType?: string;
      DeviceName?: string;
      ProductType?: string;
      ProductVersion?: string;
      UniqueDeviceID?: string;
      Identifier?: string;
    }>;
    return data
      .filter((d) => (d.ConnectionType ?? "USB") === "USB")
      .map((d) => ({
        udid: d.UniqueDeviceID ?? d.Identifier ?? "",
        name: d.DeviceName ?? "iPhone",
        productType: d.ProductType ?? "",
        productVersion: d.ProductVersion ?? "",
      }))
      .filter((d) => d.udid.length > 0);
  } catch (err) {
    debugDevice("listRealDevices failed: %s", (err as Error).message);
    return [];
  }
}

/** First connected physical device, or null. */
export function detectRealDevice(): RealDevice | null {
  return listRealDevices()[0] ?? null;
}

/**
 * Resolve the Apple Developer Team ID from the first "Apple Development"
 * code-signing identity (the team id is the cert's OU field). Returns null when
 * no identity is configured — the caller then asks the user to set
 * SERVE_SIM_WDA_TEAM explicitly.
 */
export function resolveTeamId(): string | null {
  if (process.env.SERVE_SIM_WDA_TEAM) return process.env.SERVE_SIM_WDA_TEAM;
  try {
    const list = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    const match = /"((?:Apple Development|iPhone Developer):[^"]+)"/.exec(list);
    if (!match) return null;
    const identity = match[1]!;
    const pem = execFileSync("security", ["find-certificate", "-c", identity, "-p"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    const subject = execFileSync("openssl", ["x509", "-noout", "-subject"], {
      input: pem,
      encoding: "utf-8",
      timeout: 5_000,
    });
    const ou = /OU\s*=\s*([A-Z0-9]{10})/.exec(subject);
    return ou ? ou[1]! : null;
  } catch (err) {
    debugDevice("resolveTeamId failed: %s", (err as Error).message);
    return null;
  }
}

export function defaultWdaConfig(): WdaConfig {
  return {
    wdaDir: process.env.SERVE_SIM_WDA_DIR ?? DEFAULT_WDA_DIR,
    teamId: resolveTeamId() ?? undefined,
    bundleId: process.env.SERVE_SIM_WDA_BUNDLE_ID ?? "com.serve-sim.wda.runner",
    controlPort: WDA_DEVICE_CONTROL_PORT,
    mjpegPort: WDA_DEVICE_MJPEG_PORT,
  };
}

/** Logical screen size in points, as reported by WDA's /window/size. */
export interface WindowSize {
  width: number;
  height: number;
}

/** Raised when WDA can't be launched; `instructions` is user-facing setup help. */
export class WdaSetupError extends Error {
  constructor(message: string, readonly instructions?: string) {
    super(message);
    this.name = "WdaSetupError";
  }
}

/**
 * Owns a running WebDriverAgent for one device: the xcodebuild runner process,
 * the two usbmux forwards, and an open WDA session. Provides a small typed
 * client (tap/drag/pressButton) used by the relay server.
 */
export class WdaSession {
  private runner?: ChildProcess;
  private forwards: ChildProcess[] = [];
  private sessionId?: string;
  private windowSize?: WindowSize;
  private stopped = false;

  constructor(
    readonly device: RealDevice,
    readonly config: WdaConfig,
  ) {}

  get controlBase(): string {
    return `http://127.0.0.1:${this.config.controlPort}`;
  }

  get mjpegUrl(): string {
    return `http://127.0.0.1:${this.config.mjpegPort}/`;
  }

  getWindowSize(): WindowSize | undefined {
    return this.windowSize;
  }

  /** Path to the prebuilt WebDriverAgentRunner-Runner.app, if it exists. */
  private get runnerProductPath(): string {
    return join(
      this.config.wdaDir,
      "build",
      "Build",
      "Products",
      "Debug-iphoneos",
      "WebDriverAgentRunner-Runner.app",
    );
  }

  private commonBuildArgs(): string[] {
    const args = [
      "-project",
      join(this.config.wdaDir, "WebDriverAgent.xcodeproj"),
      "-scheme",
      "WebDriverAgentRunner",
      "-destination",
      `id=${this.device.udid}`,
      "-derivedDataPath",
      join(this.config.wdaDir, "build"),
      "-allowProvisioningUpdates",
      `PRODUCT_BUNDLE_IDENTIFIER=${this.config.bundleId}`,
      "CODE_SIGN_STYLE=Automatic",
    ];
    if (this.config.teamId) args.push(`DEVELOPMENT_TEAM=${this.config.teamId}`);
    return args;
  }

  /** Build + sign the runner if its product isn't already present. */
  private async ensureBuilt(): Promise<void> {
    if (existsSync(this.runnerProductPath)) {
      debugDevice("WDA runner product already built at %s", this.runnerProductPath);
      return;
    }
    if (!existsSync(join(this.config.wdaDir, "WebDriverAgent.xcodeproj"))) {
      throw new WdaSetupError(
        `WebDriverAgent checkout not found at ${this.config.wdaDir}`,
        [
          "Set up WebDriverAgent once:",
          `  git clone --depth 1 https://github.com/appium/WebDriverAgent.git "${this.config.wdaDir}"`,
          "Then re-run serve-sim device (it will build + sign the runner).",
          "Override the location with SERVE_SIM_WDA_DIR.",
        ].join("\n"),
      );
    }
    if (!this.config.teamId) {
      throw new WdaSetupError(
        "No Apple Developer Team ID found to sign WebDriverAgent.",
        [
          "Open Xcode once and sign in with your Apple ID (Settings → Accounts),",
          "then set your team id explicitly:",
          "  export SERVE_SIM_WDA_TEAM=XXXXXXXXXX",
          "(find it under Apple Developer → Membership, or via your signing cert).",
        ].join("\n"),
      );
    }
    debugDevice("building WDA runner (team=%s bundle=%s)", this.config.teamId, this.config.bundleId);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("xcodebuild", ["build-for-testing", ...this.commonBuildArgs()], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let tail = "";
      const collect = (d: Buffer) => {
        tail = (tail + d.toString()).slice(-4000);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("exit", (code) => {
        if (code === 0 && existsSync(this.runnerProductPath)) resolve();
        else reject(new WdaSetupError(`WebDriverAgent build failed (exit ${code}).\n${tail}`));
      });
      child.once("error", reject);
    });
  }

  /** Launch the runner; resolves once it logs its on-device server URL. */
  private launchRunner(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        "xcodebuild",
        ["test-without-building", ...this.commonBuildArgs()],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      this.runner = child;

      let settled = false;
      const onLine = (buf: Buffer) => {
        const text = buf.toString();
        if (!settled && text.includes("ServerURLHere->")) {
          settled = true;
          debugDevice("WDA runner reported server URL on device");
          resolve();
        }
        if (/Test Suite '.*' (failed|did not run)|TEST EXECUTE FAILED|Testing failed/.test(text)) {
          if (!settled) {
            settled = true;
            reject(new WdaSetupError(`WebDriverAgent runner failed to launch.\n${text.slice(-2000)}`));
          }
        }
      };
      child.stdout?.on("data", onLine);
      child.stderr?.on("data", onLine);
      child.once("exit", (code) => {
        if (!settled) {
          settled = true;
          reject(new WdaSetupError(`WebDriverAgent runner exited early (code ${code}).`));
        }
      });
      child.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      // Cap the wait so a hung runner doesn't block forever.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new WdaSetupError("Timed out waiting for WebDriverAgent to start on the device."));
        }
      }, 90_000);
    });
  }

  /** usbmux-forward a single device port to the same local port. */
  private startForward(localPort: number, devicePort: number): ChildProcess {
    const pmd = findPymobiledevice3();
    if (!pmd) throw new WdaSetupError("pymobiledevice3 not found (needed for usbmux port forwarding).");
    const child = spawn(
      pmd,
      ["usbmux", "forward", String(localPort), String(devicePort), "--serial", this.device.udid],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    this.forwards.push(child);
    return child;
  }

  private async pollStatusReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const res = await wdaFetch(`${this.controlBase}/status`, {}, 2_000);
        if (res.ok) {
          const body = (await res.json()) as { value?: { ready?: boolean } };
          if (body.value?.ready) return;
        }
      } catch (err) {
        lastErr = (err as Error).message;
      }
      await delay(300);
    }
    throw new WdaSetupError(`WebDriverAgent /status never became ready. ${lastErr}`);
  }

  private async openSession(): Promise<void> {
    const res = await wdaFetch(`${this.controlBase}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: {} } }),
    });
    const body = (await res.json()) as { value?: { sessionId?: string }; sessionId?: string };
    this.sessionId = body.value?.sessionId ?? body.sessionId;
    if (!this.sessionId) throw new WdaSetupError("Failed to create a WebDriverAgent session.");
    await this.refreshWindowSize();
  }

  async refreshWindowSize(): Promise<WindowSize | undefined> {
    if (!this.sessionId) return undefined;
    try {
      const res = await wdaFetch(`${this.controlBase}/session/${this.sessionId}/window/size`);
      const body = (await res.json()) as { value?: WindowSize };
      if (body.value) this.windowSize = body.value;
    } catch (err) {
      debugDevice("window/size failed: %s", (err as Error).message);
    }
    return this.windowSize;
  }

  /** Full startup: build (if needed) → launch runner → forwards → session. */
  async start(): Promise<void> {
    await this.ensureBuilt();
    await this.launchRunner();
    this.startForward(this.config.controlPort, WDA_DEVICE_CONTROL_PORT);
    this.startForward(this.config.mjpegPort, WDA_DEVICE_MJPEG_PORT);
    await this.pollStatusReady();
    await this.openSession();
    debugDevice(
      "WDA session ready: device=%s window=%o",
      this.device.udid,
      this.windowSize,
    );
  }

  // ── Input (point coordinates are in logical points) ──

  async tap(xPoints: number, yPoints: number): Promise<void> {
    if (!this.sessionId) return;
    await wdaFetch(`${this.controlBase}/session/${this.sessionId}/wda/tap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: xPoints, y: yPoints }),
    }).catch((err) => debugDevice("tap failed: %s", (err as Error).message));
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationSec = 0.2,
  ): Promise<void> {
    if (!this.sessionId) return;
    await wdaFetch(`${this.controlBase}/session/${this.sessionId}/wda/dragfromtoforduration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromX,
        fromY,
        toX,
        toY,
        duration: durationSec,
      }),
    }).catch((err) => debugDevice("drag failed: %s", (err as Error).message));
  }

  /** Press a hardware button. WDA supports "home", "volumeUp", "volumeDown". */
  async pressButton(name: string): Promise<void> {
    if (!this.sessionId) return;
    await wdaFetch(`${this.controlBase}/session/${this.sessionId}/wda/pressButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch((err) => debugDevice("pressButton failed: %s", (err as Error).message));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const f of this.forwards) {
      try { f.kill("SIGTERM"); } catch {}
    }
    this.forwards = [];
    if (this.runner) {
      try { this.runner.kill("SIGTERM"); } catch {}
      this.runner = undefined;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch against WDA over the usbmux forward.
 *
 * `pymobiledevice3 usbmux forward` is connection-per-request: it closes the TCP
 * connection after each response. Node's global `fetch` (undici) pools sockets
 * with keep-alive and will happily reuse one the forwarder has already closed,
 * then block forever waiting for a response that never comes. Forcing
 * `Connection: close` makes undici open a fresh socket per request, and the
 * abort timeout is a belt-and-suspenders guard so a stuck call surfaces as an
 * error instead of hanging the input handler.
 */
function wdaFetch(url: string, init: RequestInit = {}, timeoutMs = 8_000): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Connection", "close");
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
}
