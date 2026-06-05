import { useState } from "react";
import { isAvccSupported } from "serve-sim-client/simulator";

/**
 * Reports whether the browser can decode H.264 via WebCodecs.
 *
 * `supported` is stable for the lifetime of the page, so it's safe to branch
 * render trees on. When false the caller should fall back to
 * {@link useMjpegStream}.
 *
 * Screen config (dimensions / orientation) used to be polled from `/config`
 * here, but it now arrives over the input WebSocket — pushed by the helper on
 * connect and on every change — so this hook no longer touches the network.
 */
export function useAvccStream() {
  const [supported] = useState(isAvccSupported);
  return { supported };
}
