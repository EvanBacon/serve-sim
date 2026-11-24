import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "http";
import type { AddressInfo } from "net";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Device3DView, type Device3DModule } from "../client/components/device-3d-view";
import { ThreeDToolbarButton } from "../client/components/three-d-toolbar-button";
import { DEVICE_3D_CHUNK_MARKERS } from "../client/device-3d/markers";
import type { Device3DHandle, ScreenHit } from "../client/device-3d/index";
import type { ScreenTouch } from "../client/utils/device-3d-mapping";
import { SimulatorToolbar } from "../client/simulator/SimulatorToolbar";
import { simMiddleware } from "../middleware";

const exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });

describe("ThreeDToolbarButton", () => {
  const render = (active: boolean) =>
    renderToStaticMarkup(
      <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
        <ThreeDToolbarButton active={active} onToggle={() => {}} />
      </SimulatorToolbar>,
    );

  test("offers 3D when off and an exit when on", () => {
    expect(render(false)).toContain('aria-label="View in 3D"');
    expect(render(false)).toContain('aria-pressed="false"');
    expect(render(true)).toContain('aria-label="Exit 3D view"');
    expect(render(true)).toContain('aria-pressed="true"');
  });
});

describe("3D chunk stays out of the 2D client", () => {
  const clientDir = join(import.meta.dir, "../client");

  test("the main client only imports the renderer's types", () => {
    const view = readFileSync(join(clientDir, "components/device-3d-view.tsx"), "utf8");
    for (const line of view.split("\n").filter((l) => /from ["']\.\.\/device-3d\//.test(l))) {
      expect(line).toMatch(/^import type /);
    }
    const client = readFileSync(join(clientDir, "client.tsx"), "utf8");
    expect(client).not.toMatch(/from ["']\.\/device-3d\//);
  });

  test("renderer-only markers appear in the renderer source", () => {
    const renderer = readFileSync(join(clientDir, "device-3d/index.ts"), "utf8");
    for (const marker of DEVICE_3D_CHUNK_MARKERS) expect(renderer).toContain(marker);
  });

  test("the middleware 404s the chunk when it was not built", async () => {
    const middleware = simMiddleware({ basePath: "/", proxyHelpers: true });
    const server = createHttpServer((req, res) => {
      void middleware(req, res, async () => {
        res.writeHead(418);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/device-3d.js`);
      expect(res.status).toBe(404);
      await res.text();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "KeyboardEvent"] as const;

function fakeModule(hit: () => ScreenHit | null) {
  const handle = {
    canvas: null as unknown as HTMLCanvasElement,
    update: mock(() => {}),
    pick: mock(() => hit()),
    orbitBy: mock(() => {}),
    fling: mock(() => {}),
    resetView: mock(() => {}),
    dispose: mock(() => {}),
  } satisfies Device3DHandle;
  const mod: Device3DModule = { mountDevice3D: mock(() => handle) };
  return { handle, mod };
}

describe("Device3DView", () => {
  let dom: Window;
  let root: Root | undefined;
  let previous: Map<string, unknown>;
  let host: HTMLElement;
  let source: HTMLElement;

  beforeEach(() => {
    dom = new Window({ url: "http://localhost/" });
    previous = new Map();
    for (const name of GLOBALS) {
      previous.set(name, (globalThis as Record<string, unknown>)[name]);
      (globalThis as Record<string, unknown>)[name] =
        name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = dom.document.createElement("div") as unknown as HTMLElement;
    source = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = undefined;
    for (const [name, value] of previous) (globalThis as Record<string, unknown>)[name] = value;
    await dom.happyDOM.close();
  });

  async function mount(mod: Device3DModule, props: Partial<Parameters<typeof Device3DView>[0]> = {}) {
    const calls = { touches: [] as ScreenTouch[], closed: 0, ready: 0 };
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <Device3DView
          chrome={null}
          deviceType="iphone"
          deviceDegrees={0}
          streamConfig={{ width: 1206, height: 2622, orientation: "portrait" }}
          sourceRoot={source}
          reducedMotion={false}
          onTouch={(t) => calls.touches.push(t)}
          onReady={() => calls.ready++}
          onClose={() => calls.closed++}
          load={async () => mod}
          {...props}
        />,
      );
    });
    return { calls, el: host.querySelector("[data-device-3d]") as HTMLElement };
  }

  function pointer(el: HTMLElement, type: string, x = 10, y = 10) {
    const event = new dom.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y });
    act(() => {
      el.dispatchEvent(event as unknown as Event);
    });
  }

  test("mounts the lazily loaded renderer into its host and reports ready", async () => {
    const { mod, handle } = fakeModule(() => null);
    const { calls, el } = await mount(mod);
    expect(mod.mountDevice3D).toHaveBeenCalledTimes(1);
    const [mountHost, options] = (mod.mountDevice3D as ReturnType<typeof mock>).mock.calls[0]!;
    expect(mountHost).toBe(el);
    expect(options.sourceRoot).toBe(source);
    expect(options.deviceType).toBe("iphone");
    expect(calls.ready).toBe(1);
    expect(handle.dispose).not.toHaveBeenCalled();
  });

  test("disposes the renderer on close", async () => {
    const { mod, handle } = fakeModule(() => null);
    await mount(mod);
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  test("reports a failed chunk load instead of mounting", async () => {
    const errors: unknown[] = [];
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <Device3DView
          chrome={null}
          deviceDegrees={0}
          streamConfig={null}
          sourceRoot={source}
          reducedMotion={false}
          onTouch={() => {}}
          onError={(e) => errors.push(e)}
          onClose={() => {}}
          load={() => Promise.reject(new Error("offline"))}
        />,
      );
    });
    expect(errors).toHaveLength(1);
  });

  test("Esc closes 3D without reaching the sim's key handlers", async () => {
    const { mod } = fakeModule(() => null);
    const { calls } = await mount(mod);
    const seen: string[] = [];
    dom.addEventListener("keydown", (e) => seen.push((e as unknown as KeyboardEvent).key));
    act(() => {
      dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(calls.closed).toBe(1);
    expect(seen).toEqual(["a"]);
  });

  test("a press on the glass is a touch on the sim", async () => {
    let hit: ScreenHit = { u: 0.5, v: 0.4, onScreen: true, onDevice: true };
    const { mod, handle } = fakeModule(() => hit);
    const { calls, el } = await mount(mod);
    pointer(el, "pointerdown");
    hit = { ...hit, v: 0.3 };
    pointer(el, "pointermove");
    pointer(el, "pointerup");
    expect(calls.touches.map((t) => t.type)).toEqual(["begin", "move", "end"]);
    expect(calls.touches[0]).toEqual({ type: "begin", x: 0.5, y: 0.4 });
    expect(calls.touches[2]!.y).toBeCloseTo(0.3, 9);
    expect(handle.orbitBy).not.toHaveBeenCalled();
  });

  test("a press beside the glass orbits and sends no touches", async () => {
    const { mod, handle } = fakeModule(() => ({ u: 1.2, v: 0.5, onScreen: false, onDevice: true }));
    const { calls, el } = await mount(mod);
    pointer(el, "pointerdown", 10, 10);
    pointer(el, "pointermove", 40, 25);
    pointer(el, "pointerup", 40, 25);
    expect(calls.touches).toEqual([]);
    expect(handle.orbitBy).toHaveBeenCalledWith(30, 15);
  });

  test("closing mid-touch lifts the finger", async () => {
    const { mod } = fakeModule(() => ({ u: 0.5, v: 0.5, onScreen: true, onDevice: true }));
    const { calls, el } = await mount(mod);
    pointer(el, "pointerdown");
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    expect(calls.touches.map((t) => t.type)).toEqual(["begin", "end"]);
  });
});
