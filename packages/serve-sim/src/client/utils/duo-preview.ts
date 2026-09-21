/** Viewer choice for a foldable preview. Null means the product default (3D). */
export type DuoPreviewMode = "3d" | "2d";

/**
 * Multi-display devices open on the Device Hub-style 3D model. The flat
 * stream is an opt-out (`"2d"`); a single-display phone never takes this path.
 */
export function duoPreviewIsThreeD(displayCount: number, mode: DuoPreviewMode | null): boolean {
  return displayCount > 1 && mode !== "2d";
}
