import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { homedir } from "node:os";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";
import { DuoPreview } from "../duo-preview";
import {
  DuoRendererError,
  duoModelPath,
  logDuoRendererFailure,
  resetDuoRendererFailureLogForTests,
  resolveDuoModel,
} from "../duo-renderer";
import { clearEventLogForTests, readEventLog } from "../event-log";

const servers: Server[] = [];
let consoleError: ReturnType<typeof spyOn>;

beforeEach(() => {
  clearEventLogForTests();
  resetDuoRendererFailureLogForTests();
  consoleError = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  consoleError.mockRestore();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

function duoSession(createDuoRenderer: DeviceSessionDependencies["createDuoRenderer"]) {
  const noop = async () => {};
  return new DeviceSession("DUO-UDID", {
    capture: {
      start: noop,
      stop: noop,
      subscribeMjpeg: async () => () => {},
      subscribeAvcc: async () => () => {},
      setPreferredScreenSize: noop,
    },
    hid: {
      touch: noop, multiTouch: noop, button: noop, buttonHid: noop, key: noop, scroll: noop,
      digitalCrown: noop, orientation: async () => false, memoryWarning: noop, softwareKeyboard: noop,
      caDebug: async () => false, pose: async () => false, hinge: async () => false,
      isFoldable: async () => true,
    },
    createDuoMonitor: () => ({ close() {}, refreshOrientation() {} }),
    createDuoRenderer,
  });
}

async function serve(session: DeviceSession): Promise<string> {
  const server = createServer((req, res) => session.handleDuoMjpeg(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("Duo 3D stream setup failures", () => {
  test("a missing model returns a 503 with stage and redacted details, not an empty socket", async () => {
    const model = duoModelPath(`${homedir()}/Applications/Xcode-27.app/Contents/Developer`);
    const session = duoSession(() => {
      throw new DuoRendererError("model_lookup", "The selected Xcode does not include the iPhone Duo 3D model.", { model_path: model });
    });
    const url = `${await serve(session)}/stream.3d.mjpeg?raw=1`;

    const response = await fetch(url);
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; stage: string; reason: string; details: { model_path: string } };
    expect(body.error).toBe("duo_renderer_unavailable");
    expect(body.stage).toBe("model_lookup");
    expect(body.reason).toContain("does not include the iPhone Duo 3D model");
    expect(body.details.model_path.startsWith("~/Applications/Xcode-27.app/")).toBe(true);
    expect(body.details.model_path).not.toContain(homedir());

    // A retrying client does not flood the log or the event log.
    expect((await fetch(url)).status).toBe(503);
    const logged = consoleError.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.startsWith("[duo-renderer]"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("model_lookup failed");
    const events = readEventLog({ device: "DUO-UDID" }).filter((event) => event.kind === "duo.renderer");
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe("capture");
    expect(events[0]!.status).toBe("error");
    expect(events[0]!.details).toMatchObject({ stage: "model_lookup", count: 2 });
    const diagnostics = await session.diagnostics();
    expect((diagnostics.streams as Record<string, { last_error: { stage: string } }>)["3d"]!.last_error.stage).toBe("model_lookup");
    session.close();
  });

  test("a worker that exits on the first render returns 503 with exit code, signal and stderr tail", async () => {
    const session = duoSession(() => ({
      close() {},
      render: async () => { throw new DuoRendererError("worker_exit", "Duo renderer exited", { exit_code: null, signal: "SIGKILL", stderr_tail: "RealityKit: no Metal device" }); },
    }));
    const url = await serve(session);
    // Give the preview a frame and a hinge so it actually renders.
    (session as unknown as { duo: DuoPreview }).duo.noteHinge(180);
    (session as unknown as { duo: DuoPreview }).duo.onCapturedFrame(new Uint8Array([1, 2, 3]));

    const response = await fetch(`${url}/stream.3d.mjpeg?raw=1`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "duo_renderer_unavailable",
      reason: "Duo renderer exited",
      stage: "worker_exit",
      details: { exit_code: null, signal: "SIGKILL", stderr_tail: "RealityKit: no Metal device" },
    });
    session.close();
  });

  test("an idle worker failure (spawn error) is reported to waiting responses", async () => {
    let fail!: (error: DuoRendererError) => void;
    const session = duoSession((onFailure) => {
      fail = onFailure;
      return { close() {}, render: () => new Promise(() => {}) };
    });
    const url = await serve(session);
    const pending = fetch(`${url}/stream.3d.mjpeg?raw=1`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    fail(new DuoRendererError("worker_spawn", "Duo renderer could not start: spawn EACCES", { code: "EACCES" }));
    const response = await pending;
    expect(response.status).toBe(503);
    expect((await response.json() as { stage: string }).stage).toBe("worker_spawn");
    session.close();
  });
});

describe("Duo first-frame deadline", () => {
  test("no hinge readback becomes a first_frame error naming the missing precondition", async () => {
    const errors: unknown[] = [];
    const preview = new DuoPreview({
      createRenderer: () => ({ close() {}, render: () => new Promise(() => {}) }),
      onProjection() {},
      onStreamError: (_res, error) => errors.push(error),
      firstFrameTimeoutMs: 20,
    });
    const response = { destroyed: false, writableEnded: false, writableLength: 0, write: () => true } as unknown as ServerResponse;
    let headers = 0;
    preview.onCapturedFrame(new Uint8Array([1]));
    preview.attach(response, { onFirstFrame: () => { headers++; } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(headers).toBe(0);
    expect(errors).toHaveLength(1);
    const error = errors[0] as DuoRendererError;
    expect(error.stage).toBe("first_frame");
    expect(error.details).toMatchObject({ has_capture_frame: true, hinge_known: false });
    expect(preview.diagnostics()).toMatchObject({ attached: 0, last_error: { stage: "first_frame" } });
    preview.close();
  });
});

describe("Duo model lookup", () => {
  test("uses DEVELOPER_DIR before xcode-select and reports the exact path tried", () => {
    const tried: string[] = [];
    const lookup = resolveDuoModel({ DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer" }, () => {
      throw new Error("xcode-select must not run");
    }, (path) => { tried.push(path); return false; });
    expect(lookup).toMatchObject({ source: "DEVELOPER_DIR", exists: false });
    expect(tried[0]).toBe("/Applications/Xcode-beta.app/Contents/SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz");
    expect(resolveDuoModel({}, () => { throw new Error("no developer dir"); })).toMatchObject({ source: "xcode-select", developerDir: null, error: "no developer dir" });
  });

  test("logs each distinct failure once", () => {
    const lines: string[] = [];
    const error = new DuoRendererError("timeout", "Duo renderer timed out after 10s", { model_path: "/x/V68.usdz" });
    expect(logDuoRendererFailure(error, (line) => lines.push(line))).toBe(true);
    expect(logDuoRendererFailure(error, (line) => lines.push(line))).toBe(false);
    expect(lines).toEqual(['[duo-renderer] timeout failed: Duo renderer timed out after 10s (model_path="/x/V68.usdz")']);
  });
});
