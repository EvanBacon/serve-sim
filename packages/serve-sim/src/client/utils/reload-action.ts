/** The home screen, which the toolbar Reload button never relaunches. */
const SPRINGBOARD = "com.apple.springboard";

/** Whether the toolbar can offer Reload for the foreground app. */
export function canReloadApp(app: { bundleId?: string } | null | undefined): boolean {
  return !!app?.bundleId && app.bundleId !== SPRINGBOARD;
}

export type ReloadAction = "js-reload" | "relaunch";

/**
 * What a toolbar Reload click does: React Native apps reload their JS
 * bundle; Shift-click, or any other app, terminates and relaunches the app.
 */
export function reloadAction({ isReactNative, shiftKey }: { isReactNative: boolean; shiftKey: boolean }): ReloadAction {
  return isReactNative && !shiftKey ? "js-reload" : "relaunch";
}
