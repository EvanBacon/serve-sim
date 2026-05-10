import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ReloadIcon } from "../icons";
import { execOnHost, shellEscape } from "../utils/exec";
import {
  PERMISSION_SERVICES,
  type PermAction,
  type PermState,
} from "../utils/permissions";

export function AppPermissionsTool({
  udid,
  bundleId,
}: {
  udid: string;
  bundleId: string | null;
}) {
  const [state, setState] = useState<PermState>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Reset assumed state whenever the foreground app changes.
  useEffect(() => { setState({}); setError(null); }, [bundleId]);

  const apply = useCallback(
    async (service: string, action: PermAction) => {
      if (!bundleId) return;
      const key = `${service}:${action}`;
      setPending(key);
      setError(null);
      try {
        const res = await execOnHost(
          `xcrun simctl privacy ${udid} ${action} ${service} ${shellEscape(bundleId)}`,
        );
        if (res.exitCode !== 0) {
          setError(res.stderr.trim() || `simctl privacy failed (exit ${res.exitCode})`);
          return;
        }
        setState((s) => ({ ...s, [service]: action === "reset" ? undefined : action }));
      } finally {
        setPending(null);
      }
    },
    [udid, bundleId],
  );

  const resetAll = useCallback(async () => {
    if (!bundleId) return;
    setPending("__all__");
    setError(null);
    try {
      const res = await execOnHost(
        `xcrun simctl privacy ${udid} reset all ${shellEscape(bundleId)}`,
      );
      if (res.exitCode !== 0) {
        setError(res.stderr.trim() || `simctl privacy failed (exit ${res.exitCode})`);
        return;
      }
      setState({});
    } finally {
      setPending(null);
    }
  }, [udid, bundleId]);

  if (!bundleId) {
    return (
      <div className="bg-panel border border-dashed border-white/10 rounded-[10px] p-4 text-white/50 text-[12px] text-center">
        Permissions appear once an app is in the foreground.
      </div>
    );
  }

  return (
    <div className="bg-panel border border-white/8 rounded-[10px] px-3 py-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between gap-1.5 bg-transparent border-none text-white/50 p-0 m-0 cursor-pointer w-full text-left leading-none"
        aria-expanded={open}
      >
        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] m-0">Permissions</span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : "rotate-0"}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {open && error && (
        <div className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md mt-2">
          {error}
        </div>
      )}

      {open && (
        <div className="relative mt-2">
          <div className="max-h-[260px] overflow-y-auto flex flex-col gap-1 py-2 [scrollbar-width:thin]">
            {PERMISSION_SERVICES.map(({ key, label }) => {
              const current = state[key];
              return (
                <div key={key} className="flex items-center justify-between gap-2 px-0.5 py-1">
                  <span className="text-[12px] text-white/90 overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0">{label}</span>
                  <div
                    className="flex gap-0.5 bg-white/[0.04] border border-white/8 rounded-md p-0.5"
                    role="group"
                    aria-label={label}
                  >
                    <PermBtn
                      active={current === "grant"}
                      pending={pending === `${key}:grant`}
                      onClick={() => apply(key, "grant")}
                      variant="grant"
                      title="Allow"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="5 12 10 17 19 7" />
                      </svg>
                    </PermBtn>
                    <PermBtn
                      active={current === "revoke"}
                      pending={pending === `${key}:revoke`}
                      onClick={() => apply(key, "revoke")}
                      variant="revoke"
                      title="Deny"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                      </svg>
                    </PermBtn>
                    <PermBtn
                      active={false}
                      pending={pending === `${key}:reset`}
                      onClick={() => apply(key, "reset")}
                      variant="reset"
                      title="Reset"
                    >
                      <ReloadIcon size={11} strokeWidth={2.4} />
                    </PermBtn>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="absolute top-0 left-0 right-0 h-[14px] pointer-events-none rounded-t-[10px] bg-[linear-gradient(to_bottom,#1c1c1e_0%,rgba(28,28,30,0)_100%)]" />
          <div className="absolute bottom-0 left-0 right-0 h-[14px] pointer-events-none bg-[linear-gradient(to_top,#1c1c1e_0%,rgba(28,28,30,0)_100%)]" />
        </div>
      )}

      {open && (
        <div className="flex justify-end pt-2">
          <button
            onClick={resetAll}
            disabled={pending === "__all__"}
            className="bg-transparent border border-white/12 text-white/70 text-[10px] px-2 py-[3px] rounded-[5px] cursor-pointer uppercase tracking-[0.04em]"
            title="xcrun simctl privacy reset all"
          >
            {pending === "__all__" ? "…" : "Reset all"}
          </button>
        </div>
      )}
    </div>
  );
}

function PermBtn({
  active,
  pending,
  onClick,
  variant,
  title,
  children,
}: {
  active: boolean;
  pending: boolean;
  onClick: () => void;
  variant: "grant" | "revoke" | "reset";
  title: string;
  children: ReactNode;
}) {
  const accent = variant === "grant" ? "#4ade80" : variant === "revoke" ? "#f87171" : "#a5b4fc";
  return (
    <button
      onClick={onClick}
      disabled={pending}
      title={title}
      aria-label={title}
      className="w-6 h-5.5 flex items-center justify-center border-none rounded p-0 cursor-pointer [transition:background_0.12s,color_0.12s]"
      style={{
        background: active ? `${accent}22` : "transparent",
        color: active ? accent : "rgba(255,255,255,0.55)",
        opacity: pending ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
