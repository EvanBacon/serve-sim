import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ClipboardTool } from "../client/components/clipboard-tool";
import type { HostActionFn, HostActionResult } from "../client/utils/exec";

const UDID = "11111111-2222-3333-4444-555555555555";
const ok = { exitCode: 0, stdout: "", stderr: "", verified: true };

async function harness(run: (ui: {
  input: (text: string) => Promise<void>;
  copy: () => Promise<void>;
  render: (udid: string) => Promise<void>;
  status: () => string;
  disabled: () => boolean;
}) => Promise<void>, host: HostActionFn) {
  const dom = new Window({ url: "http://localhost/" });
  const globals = ["window", "document", "HTMLElement", "Element", "Node", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(globals.map(key => [key, (globalThis as any)[key]]));
  for (const key of globals) (globalThis as any)[key] = key === "window" ? dom
    : key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom as any)[key];
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const render = async (udid: string) => {
    await act(async () => { root.render(<ClipboardTool udid={udid} host={host} />); });
  };
  try {
    await render(UDID);
    await run({
      render,
      input: async text => {
        await act(async () => {
          const input = container.querySelector("textarea")!;
          input.value = text;
          input.dispatchEvent(new dom.Event("input", { bubbles: true }));
        });
      },
      copy: async () => { await act(async () => { container.querySelector("button")!.click(); }); },
      status: () => container.querySelector('[role="status"]')!.textContent!,
      disabled: () => container.querySelector("button")!.disabled,
    });
  } finally {
    await act(async () => { root.unmount(); });
    await dom.happyDOM.abort();
    for (const [key, value] of previous) {
      if (value === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = value;
    }
  }
}

describe("ClipboardTool", () => {
  test("exposes an editable labelled textarea and explicit guest Paste instructions", () => {
    const html = renderToStaticMarkup(<ClipboardTool udid={UDID} />);
    expect(html).toContain("Text for simulator clipboard");
    expect(html).toContain("<textarea");
    expect(html).toContain("Copy to simulator");
    expect(html).toContain("Paste");
  });

  test("sends exact Unicode through typed RPC and requires verified success", async () => {
    const calls: unknown[] = [];
    const text = "Bridge123 ёж е\u0308ж 👩\u200d🍳\n'\"`$HOME";
    await harness(async ui => {
      expect(ui.disabled()).toBe(true);
      await ui.input(text);
      await ui.copy();
      expect(calls).toEqual([["copyClipboard", { udid: UDID, text }]]);
      expect(ui.status()).toContain("Verified");
      await ui.input("changed");
      expect(ui.status()).not.toContain("Verified");
    }, async (method, params) => { calls.push([method, params]); return ok; });
  });

  test("editing during a request cannot attach stale success to new text", async () => {
    let resolve!: (result: HostActionResult) => void;
    const pending = new Promise<HostActionResult>(r => { resolve = r; });
    await harness(async ui => {
      await ui.input("A");
      await ui.copy();
      expect(ui.disabled()).toBe(true);
      await ui.input("B");
      await ui.input("A");
      await act(async () => { resolve(ok); await pending; });
      expect(ui.status()).not.toContain("Verified");
      expect(ui.disabled()).toBe(false);
    }, () => pending);
  });

  test("switching devices discards the old draft and pending result", async () => {
    let resolve!: (result: HostActionResult) => void;
    const pending = new Promise<HostActionResult>(r => { resolve = r; });
    await harness(async ui => {
      await ui.input("A");
      await ui.copy();
      await ui.render("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
      expect(ui.disabled()).toBe(true);
      await act(async () => { resolve(ok); await pending; });
      expect(ui.status()).not.toContain("Verified");
      expect(ui.disabled()).toBe(true);
    }, () => pending);
  });

  test("refused, unverified and transport-failed copies never report success", async () => {
    for (const host of [
      async () => ({ ...ok, exitCode: 126, stderr: "clipboard unavailable", verified: false }),
      async () => ({ ...ok, verified: false }),
      async () => { throw new Error("socket unavailable"); },
    ]) {
      await harness(async ui => {
        await ui.input("A");
        await ui.copy();
        expect(ui.status()).not.toContain("Verified");
        expect(ui.status()).toContain("failed");
        expect(ui.disabled()).toBe(false);
      }, host);
    }
  });
});
