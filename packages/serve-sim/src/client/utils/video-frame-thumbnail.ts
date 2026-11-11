/** Longest edge of the poster, in pixels (the card shows it at 36 px). */
const THUMB_MAX_EDGE = 320;
const THUMB_TIMEOUT_MS = 5_000;
/** Seek this far before the end: the very last timestamp can decode blank. */
const END_OFFSET_S = 0.1;

/** Scale `width`×`height` so its longest edge is at most `maxEdge`. */
export function fitThumbSize(width: number, height: number, maxEdge = THUMB_MAX_EDGE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Where to grab the poster: the last frame, so the card shows how the recording ended. */
export function posterTime(duration: number): number {
  return Number.isFinite(duration) && duration > END_OFFSET_S ? duration - END_OFFSET_S : 0;
}

/**
 * Decode one frame of a just-downloaded MP4 in the page and return it as a
 * small JPEG data URL. Best-effort: resolves undefined on any failure or
 * after a timeout, so the caller keeps its placeholder.
 */
export function videoFrameThumbnail(blob: Blob, { timeoutMs = THUMB_TIMEOUT_MS } = {}): Promise<string | undefined> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    let settled = false;
    const finish = (thumb?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(thumb);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onerror = () => finish();
    video.onloadedmetadata = () => {
      const t = posterTime(video.duration);
      // Already at the target (t = 0): wait for data instead of a seek.
      if (t === 0) video.onloadeddata = () => draw();
      else video.currentTime = t;
    };
    video.onseeked = () => draw();
    function draw() {
      try {
        const { width, height } = fitThumbSize(video.videoWidth, video.videoHeight);
        if (!width || !height) return finish();
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish();
        ctx.drawImage(video, 0, 0, width, height);
        finish(canvas.toDataURL("image/jpeg", 0.85));
      } catch {
        finish();
      }
    }
    video.src = url;
  });
}
