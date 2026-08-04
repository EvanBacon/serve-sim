import type { HostEventStream } from "./exec";
import { streamConfigFrom } from "./sim-endpoint";

type PreviewConfig = NonNullable<Window["__SIM_PREVIEW__"]>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FetchSelectedConfigOptions = {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
};

/** Build the one-shot recovery endpoint without assuming a root middleware mount. */
export function selectedConfigEndpoint(apiEndpoint: string, device: string): string {
  const separator = apiEndpoint.includes("?") ? "&" : "?";
  return `${apiEndpoint}${separator}device=${encodeURIComponent(device)}`;
}

/**
 * Fetch the selected helper config directly. This is only used while the grid
 * reports a helper but the state stream has not delivered its config yet.
 */
export async function fetchSelectedStreamConfig(
  apiEndpoint: string,
  device: string,
  options: FetchSelectedConfigOptions = {},
): Promise<PreviewConfig | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(selectedConfigEndpoint(apiEndpoint, device), {
    cache: "no-store",
    signal: options.signal,
  });
  if (!response.ok) return null;
  const config = streamConfigFrom(await response.json() as Window["__SIM_PREVIEW__"] | null);
  return config?.device === device ? config : null;
}

/**
 * Bind one selected-device SSE subscription. The active flag is intentional:
 * a WebSocket chunk already queued when React cleans up the old selection can
 * otherwise apply a stale `null` after the new helper config and strand the UI
 * on Connecting until reload.
 */
export function bindSelectedConfigStream(
  stream: HostEventStream,
  device: string | null,
  applyConfig: (config: PreviewConfig | null) => void,
): () => void {
  let active = true;
  stream.onmessage = (event) => {
    if (!active) return;
    try {
      const config = streamConfigFrom(
        JSON.parse(event.data) as Window["__SIM_PREVIEW__"] | null,
      );
      if (config && device && config.device !== device) return;
      applyConfig(config);
    } catch {}
  };

  return () => {
    active = false;
    stream.close();
  };
}
