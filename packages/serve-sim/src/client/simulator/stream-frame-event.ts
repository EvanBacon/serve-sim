/**
 * Dispatched on the AVCC `<canvas>` after each painted frame, so the lazily
 * loaded 3D view re-uploads its screen texture only when the picture changed.
 * (The MJPEG `<img>` path already fires `load` per frame.)
 */
export const STREAM_FRAME_EVENT = "serve-sim-frame";
