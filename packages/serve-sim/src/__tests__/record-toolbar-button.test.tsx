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
