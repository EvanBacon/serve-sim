import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer as createNetServer } from "net";
import { spawn, type ChildProcess } from "child_process";
import { simMiddleware, type ServeSimState, type WebKitBridge } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";
import { STATE_DIR, stateFileForDevice } from "../state";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

describe("devtools proxy", () => {
  const udid = "DEVTOOLS-PROXY-DEVICE";
  const targetId = "sim:page:1";
  const stateFile = stateFileForDevice(udid);
  let cdp: ReturnType<typeof Bun.serve> | null = null;
  let preview: PreviewServer | null = null;
  let fakeHelperProcess: ChildProcess | null = null;

  afterEach(() => {
    cdp?.stop(true);
    cdp = null;
    preview?.stop(true);
    preview = null;
    try { rmSync(stateFile); } catch {}
    if (fakeHelperProcess?.pid) {
      try { fakeHelperProcess.kill("SIGKILL"); } catch {}
    }
    fakeHelperProcess = null;
  });

  test("lists targets through the preview origin and bridges CDP text frames", async () => {
    const cdpPort = await freePort();
    let cdpSawText = false;
    cdp = Bun.serve({
      hostname: "127.0.0.1",
      port: cdpPort,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/devtools/page/") && server.upgrade(req, { data: undefined })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          cdpSawText = typeof message === "string";
          ws.send(`cdp:${message}`);
        },
      },
    });

    mkdirSync(STATE_DIR, { recursive: true });
    fakeHelperProcess = spawn("sleep", ["60"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fakeHelperProcess.pid).toBeTruthy();
    expect(fakeHelperProcess.exitCode).toBeNull();
    const state: ServeSimState = {
      pid: fakeHelperProcess.pid!,
      port: 3100,
      device: udid,
      url: "http://127.0.0.1:3100",
      streamUrl: "http://127.0.0.1:3100/stream.mjpeg",
      wsUrl: "ws://127.0.0.1:3100/ws",
    };
    writeFileSync(stateFile, JSON.stringify(state));

    const bridge: WebKitBridge = {
      port: cdpPort,
      cdpUrl: `http://127.0.0.1:${cdpPort}`,
      async listTargets() {
        return [{
          id: targetId,
          title: "Example",
          url: "https://example.test",
          type: "page",
          udid,
        }];
      },
    };

    const previewPort = await freePort();
    preview = await servePreview({
      port: previewPort,
      middleware: simMiddleware({
        basePath: "/",
        proxyHelpers: true,
        inspectWebKitBridge: async () => bridge,
      }),
      host: "127.0.0.1",
    });

    const response = await fetch(`http://127.0.0.1:${previewPort}/devtools?device=${encodeURIComponent(udid)}`);
    expect(response.ok).toBe(true);
    const json = await response.json();
    const target = json.targets[0];
    const encodedTargetId = encodeURIComponent(targetId);
    expect(target.webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${previewPort}/devtools/page/${encodedTargetId}`);
    const frontendUrl = new URL(target.devtoolsFrontendUrl, `http://127.0.0.1:${previewPort}`);
    expect(frontendUrl.pathname).toBe("/devtools-frontend/inspector.html");
    expect(frontendUrl.searchParams.get("ws")).toBe(`127.0.0.1:${previewPort}/devtools/page/${encodedTargetId}`);
    expect(frontendUrl.searchParams.has("wss")).toBe(false);

    const echoed = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${previewPort}/devtools/page/${encodedTargetId}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("timed out waiting for CDP echo"));
      }, 2_000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      };
      ws.onmessage = (event) => {
        clearTimeout(timer);
        ws.close();
        resolve(String(event.data));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("devtools websocket failed"));
      };
    });

    expect(cdpSawText).toBe(true);
    expect(echoed).toBe('cdp:{"id":1,"method":"Runtime.enable"}');
  });
});
