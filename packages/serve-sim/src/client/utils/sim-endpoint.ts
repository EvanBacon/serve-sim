declare global {
  interface Window {
    __SIM_PREVIEW__?: {
      url: string;
      streamUrl: string;
      wsUrl: string;
      pid: number;
      port: number;
      device: string;
      basePath: string;
      axEndpoint?: string;
      appStateEndpoint?: string;
      devtoolsEndpoint?: string;
      gridApiEndpoint?: string;
      gridStartEndpoint?: string;
      gridShutdownEndpoint?: string;
      gridMemoryEndpoint?: string;
      previewEndpoint?: string;
      // Absolute path of the running serve-sim entry script. The camera tool
      // shells out via `node <bin> camera ...` so it doesn't depend on the
      // `serve-sim` binary being on the user's PATH.
      serveSimBin?: string;
      /** Bearer token required by the /exec shell-exec route. */
      execToken?: string;
    };
  }
}

/**
 * Narrow an injected `__SIM_PREVIEW__` to a usable stream config. The
 * middleware injects a minimal `{basePath, execToken}` when no helper is
 * attached (the empty state still needs the exec token); treating that as a
 * stream config mounts the simulator view with `url: undefined`, which
 * fetches `/undefined/stream.avcc` and trips the no-frames watchdog instead
 * of showing the device picker.
 */
export function streamConfigFrom(
  raw: Window["__SIM_PREVIEW__"] | null | undefined,
): NonNullable<Window["__SIM_PREVIEW__"]> | null {
  return raw && typeof raw.device === "string" && typeof raw.url === "string"
    ? raw
    : null;
}

export function simEndpoint(path: string): string {
  // When __SIM_PREVIEW__ is injected we have the canonical base path. Without
  // it (BootEmptyState — no helper running yet) the page is still being served
  // at the middleware's mount point, so derive the base from the current URL.
  // Otherwise the empty-state polls (e.g. /api, /exec) would hit the wrong
  // path under any mount other than "/", and auto-switch after boot fails.
  const configured = window.__SIM_PREVIEW__?.basePath;
  const basePath = configured ?? (window.location.pathname.replace(/\/+$/, "") || "/");
  return basePath === "/" ? `/${path}` : `${basePath}/${path}`;
}
