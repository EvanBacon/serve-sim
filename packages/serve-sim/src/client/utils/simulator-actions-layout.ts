import type { CSSProperties } from "react";

/**
 * Layout for the actions pill under the device (reload, home, screenshot,
 * record, rotate, frame) and the round inspect button beside it.
 *
 * The device column is only as wide as the rendered device, which can be
 * narrower than the pill (short windows, a resized-down simulator, or a side
 * panel open). The row must not be capped at that column width: when it was,
 * the pill shrank below its buttons and the first/last icons spilled past
 * both rounded edges. Instead the row sizes to its content, may grow past
 * the device (it stays centered under it), and is only capped by the
 * viewport. If the viewport itself is too narrow, the buttons wrap onto a
 * second row inside the pill rather than overflowing it.
 */
export const SIM_ACTIONS_ROW_CLASS =
  "inline-flex w-max max-w-[calc(100vw-16px)] shrink-0 items-center justify-center gap-2";

/** Pill style for phones/tablets/watches (Duo keeps its own nowrap layout). */
export const SIM_ACTIONS_PILL_STYLE: CSSProperties = {
  alignSelf: "center",
  minWidth: 0,
  width: "auto",
  // Cap at the viewport, not the device column (which can be narrower than
  // the pill when the bezel is hidden or the sim is resized down).
  maxWidth: "calc(100vw - 16px)",
  justifyContent: "center",
  padding: "6px 8px",
  borderRadius: 18,
};

/** The buttons inside the pill: wrap (centered) instead of overflowing it. */
export const SIM_ACTIONS_BUTTONS_STYLE: CSSProperties = {
  flexWrap: "wrap",
  justifyContent: "center",
  flexShrink: 1,
  minWidth: 0,
};
