declare global {
  interface Window {
    __SIM_PREVIEW__?: {
      url: string;
      streamUrl: string;
      wsUrl: string;
      port: number;
      device: string;
      basePath: string;
      logsEndpoint?: string;
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
    };
  }
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
