import type { AxRect } from "../../ax-shared";

/**
 * V68's integrated displays use 3 pixels per accessibility point. AX frames
 * already use native portrait coordinates; the app root can retain the cover's
 * 466×678 bounds while its children describe the 669×951 inner screen.
 * Normalize against the captured framebuffer, never that stale root or guest
 * orientation. The model projection supplies the visible rotation exactly once.
 */
export function duoAxFrame(frame: AxRect, framebuffer: { width: number; height: number }): AxRect {
  const scale = 3;
  return {
    x: frame.x * scale / framebuffer.width,
    y: frame.y * scale / framebuffer.height,
    width: frame.width * scale / framebuffer.width,
    height: frame.height * scale / framebuffer.height,
  };
}
