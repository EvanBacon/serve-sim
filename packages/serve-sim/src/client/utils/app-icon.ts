import { type ExecResult, shellEscape } from "./exec";

export interface AppDetails {
  bundleId: string;
  isReactNative: boolean;
  pid?: number;
  displayName?: string;
  shortVersion?: string;
  bundleVersion?: string;
  minOS?: string;
  executable?: string;
  appPath?: string;
  iconDataUrl?: string | null;
  loading: boolean;
  error?: string;
}

export async function fetchAppDetails(
  exec: (cmd: string) => Promise<ExecResult>,
  udid: string,
  bundleId: string,
): Promise<Partial<AppDetails>> {
  const ctn = await exec(`xcrun simctl get_app_container ${udid} ${shellEscape(bundleId)} app`);
  if (ctn.exitCode !== 0) {
    return { error: ctn.stderr.trim() || "App not found on simulator" };
  }
  const appPath = ctn.stdout.trim();
  if (!appPath) return { error: "Empty app path" };

  // Read Info.plist as JSON. plutil -convert json -o - is available on macOS.
  const plist = await exec(`plutil -convert json -o - ${shellEscape(appPath + "/Info.plist")}`);
  let info: any = {};
  if (plist.exitCode === 0) {
    try { info = JSON.parse(plist.stdout); } catch {}
  }

  // Try to find app icon. CFBundleIcons → primary → CFBundleIconFiles last entry,
  // fall back to CFBundleIconFiles / CFBundleIconFile.
  let iconName: string | undefined;
  const primary = info?.CFBundleIcons?.CFBundlePrimaryIcon
    ?? info?.["CFBundleIcons~ipad"]?.CFBundlePrimaryIcon;
  const iconFiles: string[] | undefined = primary?.CFBundleIconFiles ?? info?.CFBundleIconFiles;
  if (iconFiles && iconFiles.length > 0) iconName = iconFiles[iconFiles.length - 1];
  else if (typeof info?.CFBundleIconFile === "string") iconName = info.CFBundleIconFile;

  let iconDataUrl: string | null = null;
  if (iconName) {
    // Icons are commonly compiled into Assets.car; loose PNGs may exist as
    // <icon>@2x.png / @3x.png. Try a handful of candidates.
    const candidates = [
      `${iconName}@3x.png`,
      `${iconName}@2x.png`,
      `${iconName}.png`,
      `${iconName}60x60@3x.png`,
      `${iconName}60x60@2x.png`,
    ];
    const find = await exec(
      `bash -c ${shellEscape(
        candidates.map((c) => `[ -f ${shellEscape(appPath + "/" + c)} ] && echo ${shellEscape(appPath + "/" + c)} && exit 0`).join("; ") + "; exit 1",
      )}`,
    );
    const iconPath = find.stdout.trim();
    if (iconPath) {
      const b64 = await exec(`base64 -i ${shellEscape(iconPath)}`);
      if (b64.exitCode === 0) {
        iconDataUrl = `data:image/png;base64,${b64.stdout.replace(/\s+/g, "")}`;
      }
    }
  }

  return {
    appPath,
    displayName: info.CFBundleDisplayName ?? info.CFBundleName,
    shortVersion: info.CFBundleShortVersionString,
    bundleVersion: info.CFBundleVersion,
    minOS: info.MinimumOSVersion,
    executable: info.CFBundleExecutable,
    iconDataUrl,
  };
}

// Process-wide icon cache — keyed by udid:bundleId so a switch between
// devices doesn't reuse stale art. Values are pending fetches OR resolved
// data URLs (or null when no icon could be located).
export const appIconCache = new Map<string, Promise<string | null> | string | null>();

export function fetchAppIcon(
  exec: (cmd: string) => Promise<ExecResult>,
  udid: string,
  bundleId: string,
): Promise<string | null> {
  const key = `${udid}:${bundleId}`;
  const existing = appIconCache.get(key);
  if (existing !== undefined) {
    return Promise.resolve(existing as string | null | Promise<string | null>);
  }
  const pending = fetchAppDetails(exec, udid, bundleId).then((d) => {
    const url = d.iconDataUrl ?? null;
    appIconCache.set(key, url);
    return url;
  }).catch(() => {
    appIconCache.set(key, null);
    return null;
  });
  appIconCache.set(key, pending);
  return pending;
}
