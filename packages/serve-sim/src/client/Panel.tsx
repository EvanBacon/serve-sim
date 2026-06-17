import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";

export function Panel({
  open,
  width,
  children,
  style,
  side = "right",
}: {
  open: boolean;
  width: number;
  children: ReactNode;
  style?: CSSProperties;
  side?: "left" | "right";
}) {
  const closedTransform =
    side === "left" ? "translateX(-100%)" : "translateX(calc(100% + 24px))";
  const chromeClass =
    side === "left"
      ? "top-0 bottom-0 left-0 rounded-none border-0 border-r border-white/10 shadow-[8px_0_32px_rgba(0,0,0,0.35)]"
      : "top-3 bottom-3 right-3 rounded-[14px] border border-white/10 shadow-[0_12px_40px_rgba(0,0,0,0.55)]";

  return (
    <aside
      className={`fixed z-35 min-w-0 overflow-hidden bg-panel-bg text-white/90 backdrop-blur-[18px] [font-family:-apple-system,system-ui,sans-serif] [transition:transform_0.25s_ease,opacity_0.2s_ease] flex flex-col ${chromeClass}`}
      style={{
        width,
        transform: open ? "translateX(0)" : closedTransform,
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
      className="flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 text-[#8e8e93] [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
      aria-label={ariaLabel}
      title={title}
    >
      <X size={iconSize} strokeWidth={2} />
    </button>
  );
}
