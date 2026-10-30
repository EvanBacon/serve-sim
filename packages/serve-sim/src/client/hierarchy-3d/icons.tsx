// Inline SF Symbols–style stroke icons for the /hierarchy-3d page (no icon
// library: the page is a standalone bundle).
import type { ReactNode } from "react";
import type { NodeKind } from "./tree";

function Svg({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const RefreshIcon = () => (
  <Svg><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M12.5 1.8v3h-3" /></Svg>
);

export const LayersIcon = () => (
  <Svg><path d="M8 2.2 14 5.2 8 8.2 2 5.2Z" /><path d="M2.4 8.2 8 11l5.6-2.8" /><path d="M2.4 11 8 13.8l5.6-2.8" /></Svg>
);

/** A frame with content spilling past its bounds (dashed). */
export const ClipIcon = () => (
  <Svg>
    <rect x="2.5" y="2.5" width="8" height="8" rx="1.2" />
    <path d="M10.5 5.5h2.2a.8.8 0 0 1 .8.8v6.4a.8.8 0 0 1-.8.8H6.3a.8.8 0 0 1-.8-.8v-2.2" strokeDasharray="1.6 1.6" />
  </Svg>
);

export const ResetViewIcon = () => (
  <Svg>
    <path d="M2.5 5.5v-2a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);

export const MoreIcon = () => (
  <Svg>
    <circle cx="3.5" cy="8" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1.15" fill="currentColor" stroke="none" />
  </Svg>
);

export const SearchIcon = () => (
  <Svg size={14}><circle cx="6" cy="6" r="4.1" /><path d="m9.1 9.1 3.4 3.4" /></Svg>
);

export const ClearIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <circle cx="7" cy="7" r="6" fill="currentColor" />
    <path d="m4.9 4.9 4.2 4.2m0-4.2L4.9 9.1" stroke="var(--h3d-clear-x)" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const ChevronIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
    <path d="M3.5 1.8 6.8 5 3.5 8.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
    <path d="m2.5 6.4 2.3 2.3 4.7-5.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Small per-kind glyph for outline rows and the inspector header. */
export function KindIcon({ kind }: { kind: NodeKind }) {
  let body: ReactNode;
  switch (kind) {
    case "window":
      body = <><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" /><path d="M1.5 5.2h11" /></>;
      break;
    case "text":
      body = <path d="M3.5 3.2h7M7 3.2v7.6" />;
      break;
    case "image":
      body = <><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" /><path d="m1.8 10 3.2-3.2 2.5 2.5 1.5-1.5 3.2 3" /><circle cx="9.4" cy="5.4" r=".9" /></>;
      break;
    case "control":
      body = <><rect x="1.5" y="4" width="11" height="6" rx="3" /><circle cx="9.5" cy="7" r="1.2" /></>;
      break;
    case "scroll":
      body = <><rect x="2" y="1.5" width="10" height="11" rx="1.5" /><path d="M9.6 4v3" strokeWidth="1.6" /></>;
      break;
    default:
      body = <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" />;
  }
  return (
    <svg className={`h3d-kind h3d-kind-${kind}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      {body}
    </svg>
  );
}
