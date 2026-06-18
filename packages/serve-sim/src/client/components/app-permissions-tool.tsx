import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { ReloadIcon } from "../icons";
import { execOnHost, shellEscape } from "../utils/exec";
import { CollapsibleSection } from "./collapsible-section";
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

  // The `serve-sim permissions` subcommand handles the stores `simctl privacy`
  // can't (push notifications via BulletinBoard, location's `i<bundleId>:`
  // clients.plist keys), so the UI drives it instead of calling simctl directly.
  const cliPrefix = useMemo(() => {
    const bin = typeof window === "undefined" ? undefined : window.__SIM_PREVIEW__?.serveSimBin;
    if (!bin) return "serve-sim";
    if (/\.ts$/.test(bin)) return `bun ${shellEscape(bin)}`;
    if (/\.js$/.test(bin)) return `node ${shellEscape(bin)}`;
    return shellEscape(bin);
  }, []);

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
          `${cliPrefix} permissions ${action} ${service} ${shellEscape(bundleId)} -d ${shellEscape(udid)}`,
        );
        if (res.exitCode !== 0) {
          setError(res.stderr.trim() || `serve-sim permissions failed (exit ${res.exitCode})`);
          return;
        }
        setState((s) => ({ ...s, [service]: action === "reset" ? undefined : action }));
      } finally {
        setPending(null);
      }
    },
    [cliPrefix, udid, bundleId],
  );

  const resetAll = useCallback(async () => {
    if (!bundleId) return;
    setPending("__all__");
    setError(null);
    try {
      const res = await execOnHost(
        `${cliPrefix} permissions reset all ${shellEscape(bundleId)} -d ${shellEscape(udid)}`,
      );
      if (res.exitCode !== 0) {
        setError(res.stderr.trim() || `serve-sim permissions failed (exit ${res.exitCode})`);
        return;
      }
      setState({});
    } finally {
      setPending(null);
    }
  }, [cliPrefix, udid, bundleId]);

  if (!bundleId) {
    return <AppPermissionsLoading />;
  }

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">Permissions</span>
          <span />
        </>
      }
    >
      {error && (
        <div className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md">
          {error}
        </div>
      )}

      <div className="relative">
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
                      <Check size={11} strokeWidth={3} />
                    </PermBtn>
                    <PermBtn
                      active={current === "revoke"}
                      pending={pending === `${key}:revoke`}
                      onClick={() => apply(key, "revoke")}
                      variant="revoke"
                      title="Deny"
                    >
                      <X size={11} strokeWidth={3} />
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

      <div className="flex justify-end">
        <button
          onClick={resetAll}
          disabled={pending === "__all__"}
          className="bg-transparent border border-white/12 text-white/70 text-[10px] px-2 py-[3px] rounded-[5px] cursor-pointer uppercase tracking-[0.04em]"
          title="serve-sim permissions reset all"
        >
          {pending === "__all__" ? "…" : "Reset all"}
        </button>
      </div>
    </CollapsibleSection>
  );
}

export function AppPermissionsLoading() {
  return (
    <div
      data-testid="app-permissions-loading"
      className="bg-panel rounded-[10px] px-3 py-2"
      aria-disabled="true"
      aria-busy="true"
    >
      <div className="select-none text-white/55 min-h-[36px] leading-none py-2.5 px-1 -my-2 -mx-1 w-[calc(100%+8px)] grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left cursor-default">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] leading-none inline-flex items-center">
          Permissions
        </span>
        <span />
        <span
          data-testid="permissions-loading-indicator"
          role="status"
          aria-label="Loading permissions"
          className="size-2.5 rounded-full border border-[#5f6268] border-t-[#f4f4f5] animate-[grid-spin_0.7s_linear_infinite]"
        />
      </div>
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
