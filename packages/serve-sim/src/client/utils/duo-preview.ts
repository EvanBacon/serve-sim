/** Foldable devices always use their interactive device model. */
export function duoPreviewIsThreeD(displayCount: number): boolean {
  return displayCount > 1;
}
