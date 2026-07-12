import { describe, expect, test } from "bun:test";
import { proxyWebKitDevtoolsTargetForBrowser, type WebKitDevtoolsTarget } from "../client/utils/devtools";

const target: WebKitDevtoolsTarget = {
  id: "sim:page:1",
  title: "Example",
  url: "https://example.test",
  type: "page",
  webSocketDebuggerUrl: "ws://127.0.0.1:3200/.sim/devtools/page/sim%3Apage%3A1",
  devtoolsFrontendUrl: "/.sim/devtools-frontend/inspector.html?ws=127.0.0.1%3A3200%2F.sim%2Fdevtools%2Fpage%2Fsim%253Apage%253A1",
};

describe("proxyWebKitDevtoolsTargetForBrowser", () => {
  test("uses wss and the browser host in secure contexts", () => {
    const proxied = proxyWebKitDevtoolsTargetForBrowser(target, {
      protocol: "https:",
      host: "tunnel.example.com",
    } as Location);

    expect(proxied.webSocketDebuggerUrl).toBe("wss://tunnel.example.com/.sim/devtools/page/sim%3Apage%3A1");
    const frontendUrl = new URL(proxied.devtoolsFrontendUrl, "https://tunnel.example.com");
    expect(frontendUrl.pathname).toBe("/.sim/devtools-frontend/inspector.html");
    expect(frontendUrl.searchParams.get("wss")).toBe("tunnel.example.com/.sim/devtools/page/sim%3Apage%3A1");
    expect(frontendUrl.searchParams.has("ws")).toBe(false);
  });
});
