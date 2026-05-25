import { describe, expect, test } from "bun:test";
import { uploadDroppedFile } from "../client/utils/drop";
import type { ExecResult } from "../client/utils/exec";

function createExecRecorder(commands: string[]) {
  return async (command: string): Promise<ExecResult> => {
    commands.push(command);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

describe("uploadDroppedFile", () => {
  test("installs Android APKs with shell-escaped host arguments", async () => {
    const commands: string[] = [];

    await uploadDroppedFile(
      new File(["apk"], "app.apk", { type: "application/vnd.android.package-archive" }),
      "apk",
      createExecRecorder(commands),
      "emulator-5554",
      "android",
      () => {},
    );

    expect(commands.some((command) =>
      /^adb -s 'emulator-5554' install -r '\/tmp\/serve-sim-install-[^']+\.apk'$/.test(command),
    )).toBe(true);
    expect(commands.at(-1)).toMatch(/^rm -f '\/tmp\/serve-sim-install-[^']+\.apk'$/);
  });

  test("pushes Android media and asks MediaScanner to index the copied file", async () => {
    const commands: string[] = [];

    await uploadDroppedFile(
      new File(["jpg"], "photo.jpg", { type: "image/jpeg" }),
      "media",
      createExecRecorder(commands),
      "emulator-5554",
      "android",
      () => {},
    );

    expect(commands.some((command) =>
      /^adb -s 'emulator-5554' push '\/tmp\/serve-sim-upload-[^']+\.jpg' '\/sdcard\/Download\/serve-sim-upload-[^']+\.jpg'$/.test(command),
    )).toBe(true);
    expect(commands.some((command) =>
      /^adb -s 'emulator-5554' shell am broadcast -a android\.intent\.action\.MEDIA_SCANNER_SCAN_FILE -d 'file:\/\/\/sdcard\/Download\/serve-sim-upload-[^']+\.jpg'$/.test(command),
    )).toBe(true);
  });
});
