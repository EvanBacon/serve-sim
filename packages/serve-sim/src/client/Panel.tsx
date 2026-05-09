import type { CSSProperties, ReactNode } from "react";

// Shared chrome for the right-edge drawers (Tools, Simulators, WebKit DevTools).
// All panels share the fixed-position card, blur, border, and slide-in
// transition; only the body content differs.
const PANEL_SHELL_STYLE: CSSProperties = {
  position: "fixed",
  top: 12,
  right: 12,
  bottom: 12,
  minWidth: 0,
  background: "rgba(20,20,22,0.92)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 14,
  color: "#eee",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  transition: "transform 0.25s ease, opacity 0.2s ease",
  boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  fontFamily: "-apple-system, system-ui, sans-serif",
  zIndex: 35,
};

const PANEL_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "6px 10px 6px 12px",
  flexShrink: 0,
};

const PANEL_TITLE_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: "rgba(255,255,255,0.55)",
};

const PANEL_CLOSE_BTN_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#aaa",
  cursor: "pointer",
  padding: 4,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  flexShrink: 0,
};

export function Panel({
  open,
  width,
  children,
  style,
}: {
  open: boolean;
  width: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <aside
      style={{
        ...PANEL_SHELL_STYLE,
        width,
        transform: open ? "translateX(0)" : "translateX(calc(100% + 24px))",
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
        ...style,
      }}
      aria-hidden={!open}
    >
      {children}
    </aside>
  );
}

export function PanelHeader({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return <header style={{ ...PANEL_HEADER_STYLE, ...style }}>{children}</header>;
}

export function PanelTitle({ children }: { children: ReactNode }) {
  return <span style={PANEL_TITLE_STYLE}>{children}</span>;
}

export function PanelCloseButton({
  onClick,
  ariaLabel = "Close panel",
  title,
  iconSize = 16,
}: {
  onClick: () => void;
  ariaLabel?: string;
  title?: string;
  iconSize?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={PANEL_CLOSE_BTN_STYLE}
      aria-label={ariaLabel}
      title={title}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}
