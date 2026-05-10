import { useEffect, useState, type ReactNode } from "react";
import { type AppDetails, fetchAppDetails } from "../utils/app-icon";
import { execOnHost, shellEscape } from "../utils/exec";

export function AppDetectionTool({
  udid,
  currentApp,
}: {
  udid: string;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
}) {
  const [details, setDetails] = useState<AppDetails | null>(null);

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
    <div className="bg-panel border border-white/8 rounded-[10px] p-3">
      <div className="flex items-center gap-3 mb-2.5">
        {details.iconDataUrl ? (
          <img
            src={details.iconDataUrl}
            className="w-11 h-11 rounded-[10px] shrink-0 object-cover border border-white/8"
            alt=""
          />
        ) : (
          <div className="w-11 h-11 rounded-[10px] shrink-0 object-cover border border-white/8 bg-[#2a2a2c]" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold overflow-hidden text-ellipsis whitespace-nowrap">
            {details.displayName ?? details.bundleId}
            {details.loading && <span className="text-white/40 font-normal"> …</span>}
          </div>
          <div className="text-[11px] text-white/50 font-mono overflow-hidden text-ellipsis whitespace-nowrap" title={details.bundleId}>
            {details.bundleId}
          </div>
        </div>
      </div>

      {details.error && (
        <div className="bg-[rgba(248,113,113,0.08)] border border-[rgba(248,113,113,0.2)] text-danger-soft text-[11px] px-2 py-1.5 rounded-md mb-2.5">
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
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="7" y1="17" x2="17" y2="7" />
                      <polyline points="10 7 17 7 17 14" />
                    </svg>
                  ),
                }
              : undefined
          }
        />
      </dl>
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
  const [hover, setHover] = useState(false);
  return (
    <div
      className="flex items-baseline gap-2 min-w-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <dt className="m-0 text-[11px] text-white/50 w-[84px] shrink-0">{label}</dt>
      <dd
        className={`m-0 text-[#eee] flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap relative ${mono ? "font-mono text-[11px]" : "text-[12px]"}`}
        title={value}
      >
        {value}
        {action && (
          <div
            className={`absolute top-0 right-0 bottom-0 pl-7 flex items-center justify-end bg-[linear-gradient(to_right,rgba(28,28,30,0)_0%,#1c1c1e_55%)] [transition:opacity_0.15s_ease,transform_0.15s_ease] ${hover ? "opacity-100 translate-x-0 pointer-events-auto" : "opacity-0 translate-x-1 pointer-events-none"}`}
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
