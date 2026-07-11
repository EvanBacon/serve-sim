export const PREVIEW_PANES = ["devices", "tools", "devtools"] as const;

export type PreviewPane = (typeof PREVIEW_PANES)[number];

/** UI choices applied once when a preview page first loads. */
export type PreviewInitialState = {
  panes?: PreviewPane[];
  fit?: boolean;
};

/**
 * Parse the comma-separated value accepted by `serve-sim --panes`.
 * `none` is deliberately exclusive so a typo such as `none,tools` cannot
 * quietly produce an unexpected layout.
 */
export function parsePreviewPanes(value: string): PreviewPane[] {
  const panes = value
    .split(",")
    .map((pane) => pane.trim().toLowerCase())
    .filter(Boolean);

  if (panes.length === 1 && panes[0] === "none") return [];
  if (panes.length === 0 || panes.includes("none")) {
    throw new Error("Expected 'none' or a comma-separated list of: devices, tools, devtools.");
  }

  const invalid = panes.filter((pane) => !PREVIEW_PANES.includes(pane as PreviewPane));
  if (invalid.length > 0) {
    throw new Error(`Unknown pane${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}. Expected: ${PREVIEW_PANES.join(", ")}.`);
  }

  return [...new Set(panes)] as PreviewPane[];
}
