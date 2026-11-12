import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordToolbarButton, formatRecordingElapsed } from "../client/components/record-toolbar-button";
import { attachmentFileName, type ScreenRecordingState } from "../client/hooks/use-screen-recording";
import { SimulatorToolbar } from "../client/simulator/SimulatorToolbar";

const exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });

function render(state: ScreenRecordingState, streaming = true) {
  return renderToStaticMarkup(
    <SimulatorToolbar exec={exec} deviceUdid="booted" streaming={streaming}>
      <RecordToolbarButton state={state} onToggle={() => {}} />
      <SimulatorToolbar.Button aria-label="Sibling">x</SimulatorToolbar.Button>
    </SimulatorToolbar>,
  );
}

function buttonTag(html: string, pred: (tag: string) => boolean): string {
  const tag = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).find(pred);
  if (!tag) throw new Error("button not found");
  return tag;
}

function styleColor(tag: string): string | undefined {
  const style = tag.match(/style="([^"]*)"/)?.[1];
  if (!style) return undefined;
  for (const part of style.split(";")) {
    const [prop, ...rest] = part.split(":");
    if (prop?.trim() === "color") return rest.join(":").trim();
  }
  return undefined;
}

function ElapsedProbe({ seen }: { seen: string[] }) {
  useLayoutEffect(() => {
    seen.push(document.querySelector('[data-testid="recording-elapsed"]')?.textContent ?? "");
  });
  return null;
}

describe("RecordToolbarButton", () => {
  test("offers to record when idle", () => {
    const html = render({ status: "idle" });
    expect(html).toContain('aria-label="Record screen"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("disabled");
  });

  test("shows a stop control and elapsed time while recording", () => {
    const html = render({ status: "recording", startedAt: Date.now() - 65_000 });
    expect(html).toContain('aria-label="Stop recording"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("1:05");
  });

  test("is disabled while saving", () => {
    const html = render({ status: "saving" });
    expect(html).toContain('aria-label="Saving recording…"');
    expect(html).toContain("disabled");
  });

  test("marks the control so idle and recording can animate width and glyph", () => {
    const idle = render({ status: "idle" });
    expect(idle).toContain('data-recording="false"');
    expect(idle).toContain('data-busy="false"');
    expect(idle).toContain('data-open="false"');
    expect(idle).toContain("serve-sim-record-timer-slot");
    expect(idle).toContain('data-testid="recording-elapsed"');
    expect(idle).toContain("serve-sim-record-glyph--morph");
    expect(idle).toContain("serve-sim-record-glyph--fade");

    const rec = render({ status: "recording", startedAt: Date.now() - 65_000 });
    expect(rec).toContain('data-recording="true"');
    expect(rec).toContain('data-open="true"');
    expect(rec).toContain("1:05");
  });

  test("shows a spinner while starting or saving and keeps the timer slot closed", () => {
    const starting = render({ status: "starting" });
    expect(starting).toContain('data-busy="true"');
    expect(starting).toContain('data-open="false"');
    expect(starting).toContain("serve-sim-record-spinner");

    const saving = render({ status: "saving" });
    expect(saving).toContain('data-busy="true"');
    expect(saving).toContain('data-recording="false"');
    expect(saving).toContain('data-open="false"');
  });

  test("keeps the themed and disabled color of a sibling toolbar button when idle", () => {
    const idle = render({ status: "idle" });
    expect(styleColor(buttonTag(idle, (t) => t.includes("serve-sim-record-btn")))).toBe(
      styleColor(buttonTag(idle, (t) => t.includes('aria-label="Sibling"'))),
    );
    expect(styleColor(buttonTag(idle, (t) => t.includes("serve-sim-record-btn")))).toBeTruthy();

    const disabled = render({ status: "idle" }, false);
    expect(styleColor(buttonTag(disabled, (t) => t.includes("serve-sim-record-btn")))).toBe(
      styleColor(buttonTag(disabled, (t) => t.includes('aria-label="Sibling"'))),
    );
    const saving = render({ status: "saving" });
    expect(styleColor(buttonTag(saving, (t) => t.includes("serve-sim-record-btn")))).toBe(
      styleColor(buttonTag(render({ status: "idle" }, false), (t) => t.includes('aria-label="Sibling"'))),
    );
  });
});

test("formatRecordingElapsed", () => {
  expect(formatRecordingElapsed(0)).toBe("0:00");
  expect(formatRecordingElapsed(9_999)).toBe("0:09");
  expect(formatRecordingElapsed(600_000)).toBe("10:00");
  expect(formatRecordingElapsed(-5)).toBe("0:00");
});

test("attachmentFileName", () => {
  expect(attachmentFileName('attachment; filename="serve-sim-recording-2026.mp4"')).toBe("serve-sim-recording-2026.mp4");
  expect(attachmentFileName(null)).toBeNull();
  expect(attachmentFileName("inline")).toBeNull();
});

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;

describe("RecordToolbarButton close animation", () => {
  let dom: Window;
  let root: Root | undefined;
  let previous: Map<string, unknown>;
  let host: HTMLElement;

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
    dom.document.body.appendChild(host as never);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    await dom.happyDOM.abort();
    for (const name of GLOBALS) {
      const prior = previous.get(name);
      if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
      else (globalThis as Record<string, unknown>)[name] = prior;
    }
  });

  test("keeps the last elapsed text on the first saving commit, never flashing 0:00", async () => {
    const startedAt = Date.now() - 65_000;
    const seen: string[] = [];
    await act(async () => {
      root ??= createRoot(host);
      root.render(
        <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
          <RecordToolbarButton state={{ status: "recording", startedAt }} onToggle={() => {}} />
          <ElapsedProbe seen={seen} />
        </SimulatorToolbar>,
      );
    });
    expect(seen.at(-1)).toBe("1:05");

    await act(async () => {
      root!.render(
        <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
          <RecordToolbarButton state={{ status: "saving" }} onToggle={() => {}} />
          <ElapsedProbe seen={seen} />
        </SimulatorToolbar>,
      );
    });
    // useLayoutEffect runs after the saving DOM commit and before paint /
    // passive effect cleanup, so this would have been "0:00" on 015e773.
    expect(seen.at(-1)).toBe("1:05");
    expect(seen).not.toContain("0:00");
  });
});

describe("record toolbar motion CSS", () => {
  const clientDir = join(import.meta.dir, "../client");
  const globalCss = readFileSync(join(clientDir, "global.css"), "utf8");
  const motionCss = readFileSync(join(clientDir, "components/record-toolbar-button.css"), "utf8");

  test("is imported from global.css so it lands in the client style bundle", () => {
    expect(globalCss).toContain('@import "./components/record-toolbar-button.css";');
  });

  test("animates the timer slot from 0fr to 1fr and does not clip the button tooltip", () => {
    expect(motionCss).toContain("grid-template-columns: 0fr;");
    expect(motionCss).toContain("grid-template-columns: 1fr;");
    expect(motionCss).not.toMatch(/\.serve-sim-record-btn\s*\{[^}]*overflow:\s*hidden/);
  });

  test("reduced motion hides the morph glyph and drops width/transform animation", () => {
    const reduce = motionCss.slice(motionCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduce).toContain(".serve-sim-record-glyph--morph");
    expect(reduce).toContain("display: none");
    expect(reduce).toContain(".serve-sim-record-glyph--fade");
    expect(reduce).toContain(".serve-sim-record-timer-slot");
    expect(reduce).toMatch(/transition:\s*none/);
    expect(reduce).toContain("transform: none");
  });
});
