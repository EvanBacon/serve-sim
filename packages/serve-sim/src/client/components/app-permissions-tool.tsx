import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { ReloadIcon } from "../icons";
import { hostAction } from "../utils/exec";
import { CollapsibleSection } from "./collapsible-section";
import {
  PERMISSION_SERVICES,
  type PermAction,
  type PermStatus,
} from "../utils/permissions";
import { inkText } from "../utils/theme";

/** How often the open panel re-reads statuses, to catch in-app prompts. */
const POLL_MS = 4000;

interface Snapshot {
  key: string;
  requested: string[] | null;
  statuses: Record<string, PermStatus>;
}

export function AppPermissionsTool({
  udid,
  bundleId,
}: {
  udid: string;
  bundleId: string | null;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // The `permissions` host action runs the `serve-sim permissions`
  // subcommand, which handles the stores `simctl privacy` can't (push
  // notifications via BulletinBoard, location's `i<bundleId>:` clients.plist
  // keys). `permissionsStatus` reads them back (`permissions list`) along
  // with the usage keys in the app's Info.plist.
  const appKey = bundleId ? `${udid}|${bundleId}` : null;
  const appKeyRef = useRef(appKey);
  appKeyRef.current = appKey;

  // Every refresh takes a sequence number; only the latest reply is applied,
  // so a slow poll can't overwrite the read that follows a grant/revoke.
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!bundleId) return;
    const key = `${udid}|${bundleId}`;
    const seq = ++seqRef.current;
    const res = await hostAction("permissionsStatus", { udid, bundleId });
    // Drop superseded replies and replies for an app no longer in front.
    if (seq !== seqRef.current || appKeyRef.current !== key) return;
    if (res.exitCode !== 0) {
      setLoadError(res.stderr.trim() || "Couldn't read permissions");
      return;
    }
    setLoadError(null);
    setSnapshot({
      key,
      requested: Array.isArray(res.requested) ? (res.requested as string[]) : null,
      statuses: (res.statuses ?? {}) as Record<string, PermStatus>,
    });
  }, [udid, bundleId]);

  useEffect(() => { setError(null); setLoadError(null); }, [appKey]);

  // Load on open / app change, then poll while open and the page is visible.
  useEffect(() => {
    if (!open || !bundleId) return;
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try { await refresh(); } catch {} finally { busy = false; }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [open, bundleId, refresh]);

  const run = useCallback(
    async (pendingKey: string, service: string, action: PermAction) => {
      if (!bundleId) return;
      setPending(pendingKey);
      setError(null);
      try {
        const res = await hostAction("permissions", { udid, bundleId, action, service });
        if (res.exitCode !== 0) {
          setError(res.stderr.trim() || `serve-sim permissions failed (exit ${res.exitCode})`);
        }
        // Re-read the stores rather than guessing what the action did.
        await refresh().catch(() => {});
      } finally {
        setPending(null);
      }
    },
    [udid, bundleId, refresh],
  );

  const apply = useCallback(
    (service: string, action: PermAction) => run(`${service}:${action}`, service, action),
    [run],
  );
  const resetAll = useCallback(() => run("__all__", "all", "reset"), [run]);

  if (!bundleId) {
    return <AppPermissionsLoading />;
  }

  // Never show another app's state: until this app's first read lands, rows
  // render neutral in one flat list.
  const current = snapshot?.key === appKey ? snapshot : null;

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-ink-50 uppercase tracking-[0.08em] leading-none inline-flex items-center">Permissions</span>
          <span />
        </>
      }
    >
      {(error ?? loadError) && (
        <div className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md">
          {error ?? loadError}
        </div>
      )}

      <PermissionsList
        requested={current?.requested ?? null}
        statuses={current?.statuses ?? {}}
        pending={pending}
        onApply={apply}
      />

      <div className="flex justify-end">
        <button
          onClick={resetAll}
          disabled={pending === "__all__"}
          className="bg-transparent border border-ink/12 text-ink-70 text-[10px] px-2 py-[3px] rounded-[5px] cursor-pointer uppercase tracking-[0.04em]"
          title="serve-sim permissions reset all"
        >
          {pending === "__all__" ? "…" : "Reset all"}
        </button>
      </div>
    </CollapsibleSection>
  );
}

/**
 * The permission rows. With `requested` (from Info.plist) the list splits
 * into "Requested by app" and "All permissions"; `null` (plist unreadable or
 * not loaded yet) renders one flat list without headers.
 */
export function PermissionsList({
  requested,
  statuses,
  pending,
  onApply,
}: {
  requested: string[] | null;
  statuses: Record<string, PermStatus>;
  pending: string | null;
  onApply: (service: string, action: PermAction) => void;
}) {
  const row = ({ key, label }: { key: string; label: string }) => (
    <PermissionRow
      key={key}
      service={key}
      label={label}
      status={statuses[key] ?? "unset"}
      pending={pending}
      onApply={onApply}
    />
  );

  let body: ReactNode;
  if (!requested) {
    body = PERMISSION_SERVICES.map(row);
  } else {
    const asked = new Set(requested);
    const mine = PERMISSION_SERVICES.filter((s) => asked.has(s.key));
    const rest = PERMISSION_SERVICES.filter((s) => !asked.has(s.key));
    body = (
      <>
        <SectionLabel>Requested by app</SectionLabel>
        {mine.length > 0 ? (
          mine.map(row)
        ) : (
          <div className="text-[11px] text-ink-50 px-0.5 py-1">No usage descriptions in Info.plist</div>
        )}
        {rest.length > 0 && (
          <>
            <SectionLabel className="mt-2">All permissions</SectionLabel>
            {rest.map(row)}
          </>
        )}
      </>
    );
  }

  return (
    <div className="relative">
      <div className="max-h-[420px] overflow-y-auto flex flex-col gap-1 py-2 [scrollbar-width:thin]">
        {body}
      </div>
      <div className="absolute top-0 left-0 right-0 h-[14px] pointer-events-none rounded-t-[10px] bg-[linear-gradient(to_bottom,var(--serve-sim-panel)_0%,var(--serve-sim-panel-transparent)_100%)]" />
      <div className="absolute bottom-0 left-0 right-0 h-[14px] pointer-events-none bg-[linear-gradient(to_top,var(--serve-sim-panel)_0%,var(--serve-sim-panel-transparent)_100%)]" />
    </div>
  );
}

function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-semibold text-ink-50 uppercase tracking-[0.08em] px-0.5 pt-1 ${className}`}>
      {children}
    </div>
  );
}

function PermissionRow({
  service,
  label,
  status,
  pending,
  onApply,
}: {
  service: string;
  label: string;
  status: PermStatus;
  pending: string | null;
  onApply: (service: string, action: PermAction) => void;
}) {
  return (
    <div data-permission={service} className="flex items-center justify-between gap-2 px-0.5 py-1">
      <span className="text-[12px] text-ink-90 overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0">
        {label}
        {status === "limited" && <span className="text-[10px] text-ink-50 ml-1.5">Limited</span>}
      </span>
      <div
        className="flex gap-0.5 bg-ink/[0.04] border border-ink/8 rounded-md p-0.5"
        role="group"
        aria-label={label}
      >
        <PermBtn
          active={status === "granted" || status === "limited"}
          pending={pending === `${service}:grant`}
          onClick={() => onApply(service, "grant")}
          variant="grant"
          title="Allow"
        >
          <Check size={11} strokeWidth={3} />
        </PermBtn>
        <PermBtn
          active={status === "denied"}
          pending={pending === `${service}:revoke`}
          onClick={() => onApply(service, "revoke")}
          variant="revoke"
          title="Deny"
        >
          <X size={11} strokeWidth={3} />
        </PermBtn>
        <PermBtn
          active={false}
          pending={pending === `${service}:reset`}
          onClick={() => onApply(service, "reset")}
          variant="reset"
          title="Reset"
        >
          <ReloadIcon size={11} strokeWidth={2.4} />
        </PermBtn>
      </div>
    </div>
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
      <div className="select-none text-ink-55 min-h-[36px] leading-none py-2.5 px-1 -my-2 -mx-1 w-[calc(100%+8px)] grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left cursor-default">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] leading-none inline-flex items-center">
          Permissions
        </span>
        <span />
        <span
          data-testid="permissions-loading-indicator"
          role="status"
          aria-label="Loading permissions"
          className="size-2.5 rounded-full border border-ink/30 border-t-ink/95 animate-[grid-spin_0.7s_linear_infinite]"
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
  const accent =
    variant === "grant" ? "var(--serve-sim-success)" : variant === "revoke" ? "var(--serve-sim-danger)" : "var(--serve-sim-accent)";
  return (
    <button
      onClick={onClick}
      disabled={pending}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className="w-6 h-5.5 flex items-center justify-center border-none rounded p-0 cursor-pointer [transition:background_0.12s,color_0.12s]"
      style={{
        background: active ? `color-mix(in srgb, ${accent} 13%, transparent)` : "transparent",
        color: active ? accent : inkText(0.55),
        opacity: pending ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
