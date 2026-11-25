/**
 * Strings that only the lazily loaded 3D chunk contains. The build fails if
 * any of them shows up in the inlined preview client, and tests check the
 * client source graph for them — the 2D viewer must not pay for 3D.
 */
export const DEVICE_3D_CHUNK_MARKERS = [
  "webgl2",
  "WEBGL_lose_context",
  "#version 300 es",
  "createVertexArray",
  "EXT_texture_filter_anisotropic",
] as const;
