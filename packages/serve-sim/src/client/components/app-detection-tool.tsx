import { useEffect, useState, type ReactNode } from "react";
import { AppWindow, ArrowUpRight } from "lucide-react";
import { type AppDetails, fetchAppDetails } from "../utils/app-icon";
import { execOnHost, shellEscape } from "../utils/exec";
import { CollapsibleSection } from "./collapsible-section";

export function isSystemBundleId(bundleId: string): boolean {
  return bundleId.startsWith("com.apple.");
}

export function fallbackAppDisplayName(bundleId: string): string {
  if (bundleId === "com.apple.springboard") return "SpringBoard";
  return bundleId;
}

export function AppIconFallback({ bundleId }: { bundleId: string }) {
  const system = isSystemBundleId(bundleId);

  return (
    <div
      data-testid={system ? "system-app-icon" : "app-icon-fallback"}
      className={`w-10 h-10 rounded-[8px] shrink-0 border grid place-items-center ${
        system
          ? "border-[#3b5f99] bg-[linear-gradient(145deg,#253a5f,#162132)] text-[#c8d7ff]"
          : "border-white/10 bg-white/[0.06] text-white/80"
      }`}
      aria-label={system ? "System app" : "App icon unavailable"}
      title={system ? "System app" : "App icon unavailable"}
    >
      {system ? (
        <svg
          role="img"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
          className="size-[19px]"
          fill="currentColor"
        >
          <title>Apple</title>
          <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
        </svg>
      ) : (
        <AppWindow size={19} strokeWidth={1.9} />
      )}
    </div>
  );
}

export function AppIcon({
  bundleId,
  iconDataUrl,
}: {
  bundleId: string;
  iconDataUrl?: string | null;
}) {
  if (iconDataUrl) {
    return (
      <img
        src={iconDataUrl}
        className="w-10 h-10 rounded-[8px] shrink-0 object-cover border border-white/8"
        alt=""
      />
    );
  }
  return <AppIconFallback bundleId={bundleId} />;
}

export function AppDetectionTool({
  udid,
  currentApp,
}: {
  udid: string;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
}) {
  const [details, setDetails] = useState<AppDetails | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!currentApp) { setDetails(null); return; }
    let cancelled = false;
    setDetails({
      bundleId: currentApp.bundleId,
      isReactNative: currentApp.isReactNative,
      pid: currentApp.pid,
      loading: true,
    });
    fetchAppDetails(execOnHost, udid, currentApp.bundleId).then((extra) => {
      if (cancelled) return;
      setDetails({
        bundleId: currentApp.bundleId,
        isReactNative: currentApp.isReactNative,
        pid: currentApp.pid,
        loading: false,
        ...extra,
      });
    });
    return () => { cancelled = true; };
  }, [udid, currentApp, currentApp?.bundleId, currentApp?.pid, currentApp?.isReactNative]);

  if (!details) {
    return <AppDetectionSkeleton />;
  }

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="flex items-center gap-3 text-left"
      summary={
        <>
          <AppIcon bundleId={details.bundleId} iconDataUrl={details.iconDataUrl} />
          <AppSummaryLabel
            bundleId={details.bundleId}
            displayName={details.displayName}
          />
        </>
      }
    >
      {details.error && (
        <div className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md">
          {details.error}
        </div>
      )}

      <dl className="m-0 flex flex-col gap-1.5">
            <Row label="Version" value={details.shortVersion ? `${details.shortVersion} (${details.bundleVersion ?? "—"})` : details.loading ? "…" : "—"} />
            <Row label="Min iOS" value={details.minOS ?? (details.loading ? "…" : "—")} />
            <Row label="Executable" value={details.executable ?? (details.loading ? "…" : "—")} />
            <Row label="PID" value={details.pid != null ? String(details.pid) : "—"} />
            {details.isReactNative && <Row label="React Native" value="Yes" />}
            <Row
              label="App path"
              value={details.appPath ?? (details.loading ? "…" : "—")}
              mono
              action={
                details.appPath
                  ? {
                      title: "Reveal in Finder",
                      onClick: () => { execOnHost(`open -R ${shellEscape(details.appPath!)}`); },
                      icon: (
                        <ArrowUpRight size={11} strokeWidth={2.2} />
                      ),
                    }
                  : undefined
              }
            />
          </dl>
    </CollapsibleSection>
  );
}

export function AppDetectionSkeleton() {
  return (
    <div
      data-testid="app-detection-skeleton"
      className="bg-panel rounded-[10px] px-3 py-2"
      aria-label="Waiting for foreground app"
    >
      <div className="flex items-center gap-3 text-left min-h-[36px] leading-none py-2.5 px-1 -my-2 -mx-1 w-[calc(100%+8px)]">
        <span className="w-10 h-10 rounded-[8px] shrink-0 bg-white/[0.08]" />
        <span className="min-w-0 flex-1 flex flex-col gap-2">
          <span className="h-3.5 w-[46%] rounded-full bg-white/[0.12]" />
          <span className="h-2.5 w-[68%] rounded-full bg-white/[0.08]" />
        </span>
        <span className="w-2.5 h-2.5 rounded-full bg-white/[0.08]" />
      </div>
    </div>
  );
}

export function AppSummaryLabel({
  bundleId,
  displayName,
}: {
  bundleId: string;
  displayName?: string;
}) {
  return (
    <div className="min-w-0 flex-1 leading-tight text-left">
      <div className="text-[13px] font-semibold text-white/90 truncate">
        {displayName ?? fallbackAppDisplayName(bundleId)}
      </div>
      <div className="text-[11px] text-white/55 font-mono truncate" title={bundleId}>
        {bundleId}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  action?: { title: string; onClick: () => void; icon: ReactNode };
}) {
  return (
    <div className="group flex items-baseline gap-2 min-w-0">
      <dt className="m-0 text-[11px] text-white/50 w-21 shrink-0">{label}</dt>
      <dd
        className={`m-0 text-white/90 flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap relative ${mono ? "font-mono text-[11px]" : "text-[12px]"}`}
        title={value}
      >
        {value}
        {action && (
          <div
            className="absolute top-0 right-0 bottom-0 pl-7 flex items-center justify-end bg-[linear-gradient(to_right,rgba(28,28,30,0)_0%,#1c1c1e_55%)] [transition:opacity_0.15s_ease,transform_0.15s_ease] opacity-0 translate-x-1 pointer-events-none group-hover:opacity-100 group-hover:translate-x-0 group-hover:pointer-events-auto"
          >
            <button
              type="button"
              onClick={action.onClick}
              title={action.title}
              aria-label={action.title}
              className="w-5 h-5 flex items-center justify-center bg-transparent border-none rounded text-white cursor-pointer p-0"
            >
              {action.icon}
            </button>
          </div>
        )}
      </dd>
    </div>
  );
}
