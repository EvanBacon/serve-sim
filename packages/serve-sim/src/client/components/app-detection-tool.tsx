import { useEffect, useState, type ReactNode } from "react";
import { AppWindow, ArrowUpRight } from "lucide-react";
import { type AppDetails, fetchAppDetails } from "../utils/app-icon";
import { execOnHost, shellEscape } from "../utils/exec";
import { CollapsibleSection } from "./collapsible-section";

export function isSystemBundleId(bundleId: string): boolean {
  return bundleId.startsWith("com.apple.");
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
    return (
      <div className="bg-panel border border-dashed border-white/10 rounded-[10px] p-4 text-white/50 text-[12px] text-center">
        Waiting for an app to come to the foreground…
      </div>
    );
  }

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="flex items-center gap-3 text-left"
      summary={
        <>
          {details.iconDataUrl ? (
            <img
              src={details.iconDataUrl}
              className="w-10 h-10 rounded-[8px] shrink-0 object-cover border border-white/8"
              alt=""
            />
          ) : (
            <AppIconFallback bundleId={details.bundleId} />
          )}
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-[13px] font-semibold text-white/90 truncate">
              {details.displayName ?? details.bundleId}
              {details.loading && <span className="text-white/45 font-normal"> …</span>}
            </div>
            <div className="text-[11px] text-white/55 font-mono truncate" title={details.bundleId}>
              {details.bundleId}
            </div>
          </div>
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
