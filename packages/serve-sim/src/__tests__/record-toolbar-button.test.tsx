import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordToolbarButton, formatRecordingElapsed } from "../client/components/record-toolbar-button";
import { attachmentFileName, type ScreenRecordingState } from "../client/hooks/use-screen-recording";
import { SimulatorToolbar } from "../client/simulator/SimulatorToolbar";

const exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });

function render(state: ScreenRecordingState) {
  return renderToStaticMarkup(
    <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
      <RecordToolbarButton state={state} onToggle={() => {}} />
    </SimulatorToolbar>,
  );
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
