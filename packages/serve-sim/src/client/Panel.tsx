import type { CSSProperties, ReactNode } from "react";

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
      className="fixed top-3 right-3 bottom-3 z-35 min-w-0 overflow-hidden rounded-[14px] border border-white/10 bg-panel-bg text-white/90 shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-[18px] [font-family:-apple-system,system-ui,sans-serif] [transition:transform_0.25s_ease,opacity_0.2s_ease] flex flex-col"
      style={{
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
  return <header className="flex shrink-0 items-center justify-between gap-2.5 px-2.5 py-1.5 pl-3" style={style}>{children}</header>;
}

export function PanelTitle({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-medium text-white/55">{children}</span>;
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
      className="flex shrink-0 cursor-pointer items-center justify-center rounded bg-transparent p-1 text-white/65"
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
