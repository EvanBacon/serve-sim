import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

// Custom <select> replacement in the device-picker dropdown style. Native
// option popups are drawn by the host browser and ignore the page color
// scheme in embedded webviews (Codex, VS Code), so the popup is plain DOM.
// Portaled to <body> with fixed positioning because the tools panel scrolls
// and the collapsible sections clip overflow.
export function Select({
  label,
  value,
  options,
  disabled,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (next: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  // Second pass once the popup has a size: keep it inside the viewport (the
  // settings triggers sit near the panel's right edge and the option list is
  // wider than the trigger).
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const popup = popupRef.current;
    if (!popup) return;
    const margin = 8;
    const maxLeft = window.innerWidth - popup.offsetWidth - margin;
    if (pos.left > maxLeft) setPos({ ...pos, left: Math.max(margin, maxLeft) });
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popupRef.current?.contains(t) && !triggerRef.current?.contains(t)) close();
    };
    // Capture-phase so scrolls inside the tools panel (which don't bubble to
    // window) keep the popup glued to its trigger. Repositioning rather than
    // dismissing matters because focusing the trigger can itself scroll it
    // into view, which would otherwise close the popup as it opens.
    const onScroll = (e: Event) => {
      if (!popupRef.current?.contains(e.target as Node)) place();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // Focus the selected option once per open — keyed off `pos` because the
  // popup only exists after placement, but guarded so scroll repositions
  // don't yank focus back from arrow-key navigation.
  const focusedThisOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedThisOpen.current = false;
      return;
    }
    if (!pos || focusedThisOpen.current) return;
    const items = popupRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]");
    if (!items?.length) return;
    focusedThisOpen.current = true;
    const idx = options.findIndex((o) => o.value === value);
    items[Math.max(idx, 0)]?.focus();
  }, [open, pos, options, value]);

  const onPopupKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(popupRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items[next]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const selected = options.find((o) => o.value === value);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`text-left font-[inherit] cursor-pointer disabled:cursor-default ${className ?? ""}`}
      >
        <span className="block truncate">{selected?.label ?? value}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popupRef}
            role="listbox"
            aria-label={label}
            onKeyDown={onPopupKeyDown}
            style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth }}
            className="fixed max-h-90 overflow-y-auto bg-panel border border-white/12 rounded-[10px] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] text-[12px] text-white/90 z-50"
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className={`block w-full text-left font-[inherit] px-2.5 py-1 rounded-md cursor-pointer whitespace-nowrap transition-colors hover:bg-white/8 focus-visible:bg-white/8 outline-none ${o.value === value ? "text-accent" : ""}`}
              >
                {o.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
