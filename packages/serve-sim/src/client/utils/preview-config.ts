type PreviewConfig = NonNullable<Window["__SIM_PREVIEW__"]>;

type LocationLike = Pick<Location, "host" | "protocol">;

export function proxyPreviewConfigForBrowser(
  config: PreviewConfig | null | undefined,
  location: LocationLike,
): PreviewConfig | null {
  if (!config) return null;
  if (!config.device) return config;
  // Only re-anchor when the server opted into same-origin proxying. Without it
  // the config already holds the helper's direct URLs (embedded mounts), and
  // rewriting them to `/helper/...` would point at routes the host server
  // doesn't proxy.
  if (!config.proxyHelpers) return config;

  const basePath = config.basePath === "/"
    ? ""
    : (config.basePath ?? "").replace(/\/+$/, "");
  const devicePath = `${basePath}/helper/${encodeURIComponent(config.device)}`;
  const httpOrigin = `${location.protocol}//${location.host}`;
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";

  return {
    ...config,
    url: `${httpOrigin}${devicePath}`,
    streamUrl: `${httpOrigin}${devicePath}/stream.mjpeg`,
    wsUrl: `${wsProtocol}//${location.host}${devicePath}/ws`,
  };
}
