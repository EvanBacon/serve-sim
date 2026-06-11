import { type ReactNode } from "react";
import { Chevron } from "../icons";

// Shared collapsible card for the tool sections. Built on native
// <details>/<summary> so the open/close height transition is CSS-only (see
// `details.lem-section` in global.css) rather than a JS height animation.
//
// `open`/`onOpenChange` keep React in the loop: callers still own the state
// (default-open, programmatic expand, …) and stay synced via the `toggle`
// event the browser fires on user clicks.
export function CollapsibleSection({
  open,
  onOpenChange,
  summary,
  children,
  summaryClassName = "",
  bodyClassName = "flex flex-col gap-2.5 pt-2.5",
  className = "",
  ...dataProps
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: ReactNode;
  children: ReactNode;
  summaryClassName?: string;
  bodyClassName?: string;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <details
      open={open}
      onToggle={(e) => onOpenChange((e.currentTarget as HTMLDetailsElement).open)}
      className={`lem-section bg-panel border border-white/8 rounded-[10px] px-3 py-2 ${className}`}
      {...dataProps}
    >
      <summary
        className={`lem-toggle cursor-pointer select-none text-white/90 min-h-[36px] leading-none py-2.5 px-1 -my-2 -mx-1 w-[calc(100%+8px)] ${summaryClassName}`}
      >
        {summary}
        <Chevron open={open} />
      </summary>
      <div className={bodyClassName}>{children}</div>
    </details>
  );
}
