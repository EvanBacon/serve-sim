/** The home screen, which the toolbar Reload button never relaunches. */
const SPRINGBOARD = "com.apple.springboard";

/** Whether the toolbar can offer Reload for the foreground app. */
export function canReloadApp(app: { bundleId?: string } | null | undefined): boolean {
  return !!app?.bundleId && app.bundleId !== SPRINGBOARD;
}
