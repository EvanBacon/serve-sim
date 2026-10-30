// The toolbar's "⋯" popover: a small keyboard-accessible menu holding the
// less common view options, plus a shortcut reference.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckIcon, MoreIcon } from "./icons";

export type MenuEntry =
  | { type: "check"; label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }
  | { type: "radio"; label: string; checked: boolean; onSelect: () => void }
  | { type: "action"; label: string; onSelect: () => void; shortcut?: string }
  | { type: "separator" }
  | { type: "heading"; label: string };

export function OverflowMenu({ entries, footer }: { entries: MenuEntry[]; footer?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popoverRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    // Keep the page's global shortcuts (R, F, arrows…) out of the menu.
    e.stopPropagation();
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focus(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focus(at < 0 ? -1 : at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focus(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focus(-1);
    }
  };

  return (
    <div className="h3d-menu-anchor">
      <button
        ref={buttonRef}
        type="button"
        className="h3d-icon-btn"
        aria-label="More options"
        title="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }
        }}
      >
        <MoreIcon />
      </button>
      {open && (
        <div ref={popoverRef} className="h3d-popover" onKeyDown={onKeyDown}>
          <div ref={menuRef} id={menuId} role="menu" aria-label="View options">
            {entries.map((entry, i) => {
              if (entry.type === "separator") return <div key={i} role="separator" className="h3d-menu-sep" />;
              if (entry.type === "heading") return <div key={i} role="presentation" className="h3d-menu-heading">{entry.label}</div>;
              const checkable = entry.type === "check" || entry.type === "radio";
              const activate = () => {
                if (entry.type === "check") entry.onChange(!entry.checked);
                else {
                  entry.onSelect();
                  if (entry.type === "action") close(true);
                }
              };
              return (
                <div
                  key={i}
                  role={entry.type === "check" ? "menuitemcheckbox" : entry.type === "radio" ? "menuitemradio" : "menuitem"}
                  aria-checked={checkable ? entry.checked : undefined}
                  tabIndex={-1}
                  className="h3d-menu-item"
                  title={entry.type === "check" ? entry.hint : undefined}
                  onClick={activate}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      activate();
                    }
                  }}
                  onPointerMove={(e) => (e.currentTarget as HTMLElement).focus()}
                >
                  <span className="h3d-menu-check">{checkable && entry.checked ? <CheckIcon /> : null}</span>
                  <span className="h3d-menu-label">{entry.label}</span>
                  {entry.type === "action" && entry.shortcut && <kbd className="h3d-kbd">{entry.shortcut}</kbd>}
                </div>
              );
            })}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
}
