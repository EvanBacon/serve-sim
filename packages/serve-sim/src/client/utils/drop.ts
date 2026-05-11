import type { ExecResult } from "./exec";

// ─── File drop (drag media/ipa onto the simulator) ───
//
// Media → `xcrun simctl addmedia`   (Photos)
// .ipa  → `xcrun simctl install`    (install app on simulator)
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

// 256KB per chunk. macOS ARG_MAX is 1MB, so this leaves generous headroom
// for the bash/echo wrapper while sharply cutting round-trips on large .ipa
// uploads (100MB → ~400 calls instead of ~3200 at 32KB).
export const DROP_CHUNK_SIZE = 262144;
export const DROP_MAX_FILE_SIZE = 500 * 1024 * 1024;

export type DropKind = "media" | "ipa";

export function fileExtension(file: File): string {
  const name = file.name;
  const dot = name.lastIndexOf(".");
  if (dot >= 0) return name.slice(dot + 1).toLowerCase();
  if (file.type.startsWith("video/")) return "mp4";
  return "jpg";
}

export function dropKindFor(file: File): DropKind | null {
  if (fileExtension(file) === "ipa") return "ipa";
  if (DROP_MEDIA_MIME_TYPES.has(file.type)) return "media";
  return null;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
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
  const buffer = await file.arrayBuffer();
  const b64 = arrayBufferToBase64(buffer);
  for (let offset = 0; offset < b64.length; offset += DROP_CHUNK_SIZE) {
    const chunk = b64.slice(offset, offset + DROP_CHUNK_SIZE);
    const op = offset === 0 ? ">" : ">>";
    const result = await exec(`bash -c 'echo ${chunk} | base64 -d ${op} ${tmpPath}'`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Write failed (exit ${result.exitCode})`);
    }
  }
  return tmpPath;
}

export async function uploadDroppedFile(
  file: File,
  kind: DropKind,
  exec: (command: string) => Promise<ExecResult>,
  udid: string,
  onProgress: (progress: number | null) => void,
) {
  if (file.size > DROP_MAX_FILE_SIZE) {
    throw new Error("File too large (max 500MB)");
  }

  const ext = kind === "ipa" ? "ipa" : fileExtension(file);
  const prefix = kind === "ipa" ? "serve-sim-install" : "serve-sim-upload";
  const tmpPath = `/tmp/${prefix}-${crypto.randomUUID()}.${ext}`;

  try {
    onProgress(0);
    const buffer = await file.arrayBuffer();
    const b64 = arrayBufferToBase64(buffer);

    let lastReportedPct = 0;
    for (let offset = 0; offset < b64.length; offset += DROP_CHUNK_SIZE) {
      const chunk = b64.slice(offset, offset + DROP_CHUNK_SIZE);
      const op = offset === 0 ? ">" : ">>";
      const result = await exec(`bash -c 'echo ${chunk} | base64 -d ${op} ${tmpPath}'`);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Write failed (exit ${result.exitCode})`);
      }
      const written = Math.min(offset + DROP_CHUNK_SIZE, b64.length);
      const pct = Math.floor((written / b64.length) * 100);
      if (pct !== lastReportedPct) {
        lastReportedPct = pct;
        onProgress(written / b64.length);
      }
    }

    // install/addmedia gives no progress signal — flip to indeterminate.
    onProgress(null);
    const cmd = kind === "ipa"
      ? `xcrun simctl install ${udid} ${tmpPath}`
      : `xcrun simctl addmedia ${udid} ${tmpPath}`;
    const result = await exec(cmd);
    if (result.exitCode !== 0) {
      const label = kind === "ipa" ? "install" : "addmedia";
      throw new Error(result.stderr || `${label} failed (exit ${result.exitCode})`);
    }
  } finally {
    exec(`bash -c 'rm -f ${tmpPath}'`).catch(() => {});
  }
}
