import { useEffect, useState, type ReactNode } from "react";
import { type AppDetails, fetchAppDetails } from "../utils/app-icon";
import { execOnHost, shellEscape } from "../utils/exec";
import { Chevron } from "../icons";
import { PlatformBadge, platformLabel, type DevicePlatform } from "./platform-badge";

export function AppDetectionTool({
  udid,
  currentApp,
  platform = "ios",
}: {
  udid: string;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
  platform?: DevicePlatform;
}) {
  const [details, setDetails] = useState<AppDetails | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!currentApp) { setDetails(null); return; }
    let cancelled = false;
    const baseDetails: AppDetails = {
      bundleId: currentApp.bundleId,
      isReactNative: currentApp.isReactNative,
      pid: currentApp.pid,
      loading: platform === "ios",
    };
    setDetails(baseDetails);
    if (platform === "android") return () => { cancelled = true; };
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
  }, [udid, currentApp, currentApp?.bundleId, currentApp?.pid, currentApp?.isReactNative, platform]);

  if (!details) {
    return (
      <div className="bg-panel border border-dashed border-white/10 rounded-[10px] p-4 text-white/50 text-[12px] text-center">
        Waiting for an app to come to the foreground…
      </div>
    );
  }

  return (
    <div className="bg-panel border border-white/8 rounded-[10px] flex flex-col gap-2.5 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="lem-toggle flex items-center gap-3 bg-transparent border-none text-white/90 py-2 px-1 -my-2 -mx-1 cursor-pointer w-[calc(100%+8px)] text-left min-h-[36px]"
        aria-expanded={open}
      >
        {details.iconDataUrl ? (
          <img
            src={details.iconDataUrl}
            className="w-10 h-10 rounded-[8px] shrink-0 object-cover border border-white/8"
            alt=""
          />
        ) : platform === "android" ? (
          <div className="w-10 h-10 rounded-[8px] shrink-0 border border-white/8 bg-[#052e24] text-[#bbf7d0] flex items-center justify-center text-[10px] font-mono">
            APK
          </div>
        ) : (
          <div className="w-10 h-10 rounded-[8px] shrink-0 border border-white/8 bg-white/[0.04]" />
        )}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[13px] font-semibold text-white/90 truncate flex items-center gap-1.5">
            <span className="truncate">{details.displayName ?? appTitle(details.bundleId, platform)}</span>
            <PlatformBadge platform={platform} compact />
            {details.loading && <span className="text-white/45 font-normal">...</span>}
          </div>
          <div className="text-[11px] text-white/55 font-mono truncate" title={details.bundleId}>
            {details.bundleId}
          </div>
        </div>
        <Chevron open={open} />
      </button>

      {open && (
        <>
          {details.error && (
            <div className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md">
              {details.error}
            </div>
          )}

          <dl className="m-0 flex flex-col gap-1.5">
            <Row label="Platform" value={platformLabel(platform)} />
            {platform === "android" ? (
              <>
                <Row label="Package" value={details.bundleId} mono />
                <Row label="PID" value={details.pid != null ? String(details.pid) : "—"} />
                {details.isReactNative && <Row label="React Native" value="Yes" />}
              </>
            ) : (
              <>
                <Row label="Version" value={details.shortVersion ? `${details.shortVersion} (${details.bundleVersion ?? "—"})` : details.loading ? "..." : "—"} />
                <Row label="Min iOS" value={details.minOS ?? (details.loading ? "..." : "—")} />
                <Row label="Executable" value={details.executable ?? (details.loading ? "..." : "—")} />
                <Row label="PID" value={details.pid != null ? String(details.pid) : "—"} />
                {details.isReactNative && <Row label="React Native" value="Yes" />}
                <Row
                  label="App path"
                  value={details.appPath ?? (details.loading ? "..." : "—")}
                  mono
                  action={
                    details.appPath
                      ? {
                          title: "Reveal in Finder",
                          onClick: () => { execOnHost(`open -R ${shellEscape(details.appPath!)}`); },
                          icon: (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="7" y1="17" x2="17" y2="7" />
                              <polyline points="10 7 17 7 17 14" />
                            </svg>
                          ),
                        }
                      : undefined
                  }
                />
              </>
            )}
          </dl>
        </>
      )}
    </div>
  );
}

function appTitle(bundleId: string, platform: DevicePlatform): string {
  if (platform === "ios") return bundleId;
  const last = bundleId.split(".").filter(Boolean).at(-1);
  return last || bundleId;
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
