import { describe, expect, test } from "bun:test";
import { startHostPathDrop } from "../client/hooks/use-media-drop";
import type { HostActionResult } from "../client/utils/exec";

describe("startHostPathDrop", () => {
  test("dismisses the screenshot toast when a host screenshot path is dropped", async () => {
    const events: string[] = [];
    const host = async (method: string): Promise<HostActionResult> => {
      events.push(method);
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const done = startHostPathDrop({
      hostPath: "/Users/me/Desktop/serve-sim-screenshot.png",
      host,
      udid: "UDID",
      onUploadStart: (name, kind) => {
        events.push(`start:${name}:${kind}`);
        return "upload-1";
      },
      onUploadProgress: (id, progress) => {
        events.push(`progress:${id}:${String(progress)}`);
      },
      onUploadEnd: (id, ok) => {
        events.push(`end:${id}:${String(ok)}`);
      },
      onHostPathDrop: (path) => {
        events.push(`dismiss:${path}`);
      },
    });

    expect(events[0]).toBe("dismiss:/Users/me/Desktop/serve-sim-screenshot.png");
    expect(events[1]).toBe("start:serve-sim-screenshot.png:media");
    await done;
    expect(events).toContain("addMedia");
    expect(events).toContain("end:upload-1:true");
  });
});
