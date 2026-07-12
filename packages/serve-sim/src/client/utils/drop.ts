import { shellEscape, type ExecResult } from "./exec";

// ─── File drop (drag media/ipa onto the simulator) ───
//
// Media → `xcrun simctl addmedia` / Android Downloads + media scan
// .ipa/.apk → app install on simulator/emulator
//
// Files are streamed to /tmp over /exec in base64-chunked bash `echo | base64 -d`
// calls. No sonner dep here, so uploads surface in an inline toast list.

export const DROP_MEDIA_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

// 192KB of raw bytes per chunk → ~256KB of base64 per exec. macOS ARG_MAX is
// 1MB, so this leaves generous headroom for the bash/echo wrapper while
// sharply cutting round-trips on large .ipa uploads. Each chunk is decoded by
// its own `base64 -d`, so chunks are independent of each other.
export const DROP_CHUNK_BYTES = 196608;
export const DROP_MAX_FILE_SIZE = 500 * 1024 * 1024;

// Custom drag flavor carrying a path that already exists on the host (e.g. the
// screenshot pill). Dropping it on the simulator skips the upload and adds the
// file to Photos in place. A non-text MIME type so text editors ignore it.
export const DROP_HOST_PATH_TYPE = "application/x-serve-sim-host-path";

// Add a host-resident image/video straight to Photos — no upload round-trip,
// since the file is already on disk.
export async function addHostMediaToPhotos(
  path: string,
  exec: (command: string) => Promise<ExecResult>,
  udid: string,
) {
  const result = await exec(`xcrun simctl addmedia ${udid} ${shellEscape(path)}`);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `addmedia failed (exit ${result.exitCode})`);
  }
}

export type DropKind = "media" | "ipa" | "apk";

export function fileExtension(file: File): string {
  const name = file.name;
  const dot = name.lastIndexOf(".");
  if (dot >= 0) return name.slice(dot + 1).toLowerCase();
  if (file.type.startsWith("video/")) return "mp4";
  return "jpg";
}

export function dropKindFor(file: File): DropKind | null {
  const ext = fileExtension(file);
  if (ext === "ipa") return "ipa";
  if (ext === "apk") return "apk";
  if (DROP_MEDIA_MIME_TYPES.has(file.type)) return "media";
  return null;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // 32KB blocks keep fromCharCode's argument count under engine limits while
  // avoiding a per-byte concat loop that stalls the main thread on big files.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Stream `file` into `tmpPath` one slice at a time. Reading and encoding per
// slice (instead of base64ing the whole file up front) keeps peak memory at
// one chunk regardless of file size and never blocks the main thread long
// enough to stall the simulator stream.
async function streamFileToHostPath(
  file: File,
  tmpPath: string,
  exec: (command: string) => Promise<ExecResult>,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  let lastReportedPct = 0;
  for (let offset = 0; offset < file.size; offset += DROP_CHUNK_BYTES) {
    const slice = await file.slice(offset, offset + DROP_CHUNK_BYTES).arrayBuffer();
    const chunk = arrayBufferToBase64(slice);
    const op = offset === 0 ? ">" : ">>";
    const result = await exec(`bash -c 'echo ${chunk} | base64 -d ${op} ${tmpPath}'`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Write failed (exit ${result.exitCode})`);
    }
    if (!onProgress) continue;
    const written = Math.min(offset + DROP_CHUNK_BYTES, file.size);
    const pct = Math.floor((written / file.size) * 100);
    if (pct !== lastReportedPct) {
      lastReportedPct = pct;
      onProgress(written / file.size);
    }
  }
}

// Stream a file to /tmp via the /exec base64 chunk loop. Used by the camera
// panel to stage image/video sources for `serve-sim camera --file`.
// Caller is responsible for the lifetime of the temp file.
export async function uploadFileToTmp(
  file: File,
  prefix: string,
  ext: string,
  exec: (command: string) => Promise<ExecResult>,
): Promise<string> {
  if (file.size > DROP_MAX_FILE_SIZE) {
    throw new Error("File too large (max 500MB)");
  }
  const tmpPath = `/tmp/${prefix}-${crypto.randomUUID()}.${ext}`;
  await streamFileToHostPath(file, tmpPath, exec);
  return tmpPath;
}

export async function uploadDroppedFile(
  file: File,
  kind: DropKind,
  exec: (command: string) => Promise<ExecResult>,
  udid: string,
  platform: "ios" | "android",
  onProgress: (progress: number | null) => void,
) {
  if ((platform === "ios" && kind === "apk") || (platform === "android" && kind === "ipa")) {
    throw new Error(`${kind.toUpperCase()} files are not supported on ${platform}`);
  }

  if (file.size > DROP_MAX_FILE_SIZE) {
    throw new Error("File too large (max 500MB)");
  }

  const ext = kind === "ipa" || kind === "apk" ? kind : fileExtension(file);
  const prefix = kind === "ipa" || kind === "apk" ? "serve-sim-install" : "serve-sim-upload";
  const tmpPath = `/tmp/${prefix}-${crypto.randomUUID()}.${ext}`;

  try {
    onProgress(0);
    await streamFileToHostPath(file, tmpPath, exec, onProgress);

    // install/addmedia gives no progress signal — flip to indeterminate.
    onProgress(null);
    const runCommand = async (cmd: string) => {
      const result = await exec(cmd);
      if (result.exitCode === 0) return;
      const label = kind === "ipa" || kind === "apk" ? "install" : "addmedia";
      throw new Error(result.stderr || `${label} failed (exit ${result.exitCode})`);
    };

    const escapedUdid = shellEscape(udid);
    const escapedTmpPath = shellEscape(tmpPath);
    if (platform === "android") {
      if (kind === "apk") {
        await runCommand(`adb -s ${escapedUdid} install -r ${escapedTmpPath}`);
      } else {
        const basename = tmpPath.split("/").pop()!;
        const devicePath = `/sdcard/Download/${basename}`;
        await runCommand(`adb -s ${escapedUdid} push ${escapedTmpPath} ${shellEscape(devicePath)}`);
        await runCommand(
          `adb -s ${escapedUdid} shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellEscape(`file://${devicePath}`)}`,
        );
      }
    } else {
      await runCommand(
        kind === "ipa"
          ? `xcrun simctl install ${escapedUdid} ${escapedTmpPath}`
          : `xcrun simctl addmedia ${escapedUdid} ${escapedTmpPath}`,
      );
    }
  } finally {
    exec(`rm -f ${shellEscape(tmpPath)}`).catch(() => {});
  }
}
