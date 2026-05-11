import { useEffect, useRef, useState } from "react";
import { groupTargetsByApp } from "../../devtools-targets";
import { useAppIcons } from "../hooks/use-app-icons";
import {
  postHighlightTarget,
  postReleaseHighlights,
  type WebKitDevtoolsTarget,
} from "../utils/devtools";

export function WebKitTargetPicker({
  udid,
  targets,
  selected,
  onSelectTarget,
  onRefresh,
}: {
  udid: string;
  targets: WebKitDevtoolsTarget[];
  selected: WebKitDevtoolsTarget | null;
  onSelectTarget: (id: string) => void;
  onRefresh: () => void;
}) {
  const groups = groupTargetsByApp(targets);
  const bundleIds = groups.map((g) => g.bundleId).filter((id): id is string => !!id);
  const icons = useAppIcons(udid, bundleIds);
  const [open, setOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (open) return;
    if (hoveredRef.current) {
      postHighlightTarget(hoveredRef.current, false);
      hoveredRef.current = null;
    }
    postReleaseHighlights();
  }, [open]);

  useEffect(() => {
    const onLeave = () => postReleaseHighlights();
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, []);

  const label = selected
    ? (selected.title || selected.url || selected.appName || "Untitled").slice(0, 90)
    : "Select target";

  return (
    <div ref={containerRef} className="relative w-full min-w-0">
      <button
        type="button"
        onClick={() => {
          setOpen((wasOpen) => {
            if (!wasOpen) onRefresh();
            return !wasOpen;
          });
        }}
        className="w-full min-w-0 h-[26px] flex items-center justify-between gap-2 bg-panel text-white/90 border border-white/12 rounded-md text-[12px] px-2 cursor-pointer text-left"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="WebKit target"
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap min-w-0">{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute top-[calc(100%+4px)] left-0 m-0 p-1 list-none bg-panel border border-white/12 rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.5)] min-w-[220px] max-w-[360px] max-h-[320px] overflow-y-auto z-50"
        >
          {groups.map((group) => {
            const iconUrl = group.bundleId ? icons[group.bundleId] : null;
            return (
            <li key={group.key} className="list-none m-0 p-0">
              <div className="flex items-center gap-2 px-1.5 pt-1 pb-0.5 text-[12px] font-semibold text-white/[0.92]">
                {iconUrl ? (
                  <img src={iconUrl} alt="" className="w-4 h-4 rounded-[3px] shrink-0 object-cover" />
                ) : (
                  <span className="w-4 h-4 rounded-[3px] shrink-0 object-cover" aria-hidden="true" />
                )}
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{group.appName}</span>
              </div>
              <ul role="group" className="list-none m-0 p-0 pl-[26px]">
                {group.targets.map((target) => {
                  const isSelected = selected?.id === target.id;
                  const isDisabled = !!target.inUseByOtherInspector && !isSelected;
                  const title = (target.title || target.url || target.appName || "Untitled").slice(0, 90);
                  const hovered = hoveredId === target.id && !isDisabled;
                  const baseCls = "flex flex-col px-2 py-[3px] rounded text-[12px] leading-[1.35]";
                  const stateCls = isDisabled
                    ? "opacity-40 cursor-not-allowed italic text-white/85"
                    : hovered
                    ? "bg-[rgba(10,132,255,0.22)] text-white/85 cursor-pointer"
                    : isSelected
                    ? "bg-white/[0.06] text-white/85 cursor-pointer"
                    : "text-white/85 cursor-pointer";
                  return (
                    <li
                      key={target.id}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={isDisabled}
                      tabIndex={isDisabled ? -1 : 0}
                      title={isDisabled ? "Already being inspected by another debugger" : undefined}
                      onMouseEnter={() => {
                        if (isDisabled) return;
                        if (hoveredRef.current && hoveredRef.current !== target.id) {
                          postHighlightTarget(hoveredRef.current, false);
                        }
                        hoveredRef.current = target.id;
                        setHoveredId(target.id);
                        postHighlightTarget(target.id, true);
                      }}
                      onMouseLeave={() => {
                        if (hoveredRef.current === target.id) {
                          postHighlightTarget(target.id, false);
                          hoveredRef.current = null;
                        }
                        setHoveredId((prev) => (prev === target.id ? null : prev));
                      }}
                      onClick={() => {
                        if (isDisabled) return;
                        onSelectTarget(target.id);
                        setOpen(false);
                      }}
                      className={`${baseCls} ${stateCls}`}
                    >
                      <span className="block overflow-hidden text-ellipsis whitespace-nowrap">{title}</span>
                      {target.url && target.url !== "about:blank" && (
                        <span className="block font-mono text-[10px] text-white/[0.42] overflow-hidden text-ellipsis whitespace-nowrap">{target.url}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
