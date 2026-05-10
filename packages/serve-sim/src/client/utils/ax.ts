import { AX_UNAVAILABLE_ERROR } from "../../ax-shared";
import type { AxElement, AxRect, AxSnapshot } from "../../ax-shared";

export function isAxeUnavailable(snapshot: AxSnapshot | null) {
  return snapshot?.errors?.includes(AX_UNAVAILABLE_ERROR) ?? false;
}

export function axElementsEqual(a: AxElement, b: AxElement) {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.path !== b.path ||
    a.label !== b.label ||
    a.value !== b.value ||
    a.role !== b.role ||
    a.type !== b.type ||
    a.enabled !== b.enabled
  ) return false;
  const fa = a.frame, fb = b.frame;
  return (
    fa === fb ||
    (fa.x === fb.x && fa.y === fb.y && fa.width === fb.width && fa.height === fb.height)
  );
}

export function axNodeForElement(element: AxElement, index: number) {
  const label = element.label || element.role || `element ${index + 1}`;
  const role = element.role || element.type;
  return {
    id: element.id,
    path: element.path,
    label,
    value: element.value,
    role,
    type: element.type,
    enabled: element.enabled,
    frame: element.frame,
  };
}

export function clampAxFrameForScreen(
  frame: AxRect,
  screen: { width: number; height: number },
): AxRect | null {
  const x = Math.max(0, frame.x);
  const y = Math.max(0, frame.y);
  const right = Math.min(screen.width, frame.x + frame.width);
  const bottom = Math.min(screen.height, frame.y + frame.height);
  const width = Math.max(0, right - x);
  const height = Math.max(0, bottom - y);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function axElementKey(element: AxElement) {
  // element.id is AXUniqueId when present, otherwise falls back to path.
  // Prefer it over path so React keys and selection survive sibling reorders.
  return element.id;
}

export function axFrameString(frame: AxRect) {
  return `${frame.x},${frame.y} ${frame.width}x${frame.height}`;
}

export function axElementSummary(axNode: ReturnType<typeof axNodeForElement>) {
  const parts = [
    `AX label: ${axNode.label || "Unlabeled"}`,
    axNode.role ? `role: ${axNode.role}` : "",
    axNode.type ? `type: ${axNode.type}` : "",
    axNode.value ? `value: ${axNode.value}` : "",
    axNode.id ? `id: ${axNode.id}` : "",
    `path: ${axNode.path}`,
    `frame: ${axFrameString(axNode.frame)}`,
  ];
  return parts.filter(Boolean).join("; ");
}
