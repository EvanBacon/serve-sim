import { simMiddleware, type SimMiddlewareOptions } from "serve-sim/middleware";

export type ExpoServeSimOptions = SimMiddlewareOptions;

type ConnectMiddleware = (
  req: any,
  res: any,
  next: (err?: unknown) => void,
) => void;

interface MetroLikeConfig {
  server?: {
    enhanceMiddleware?: (
      middleware: ConnectMiddleware,
      server: unknown,
    ) => ConnectMiddleware;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Patch a Metro config so the `serve-sim` preview UI is mounted on the dev
 * server. Drop-in: the returned config is the same object, mutated in place.
 *
 * ```js
 * const { getDefaultConfig } = require("expo/metro-config");
 * const { withSimServe } = require("expo-serve-sim");
 *
 * module.exports = withSimServe(getDefaultConfig(__dirname));
 * // → preview at http://localhost:8081/.sim
 * ```
 *
 * Composes cleanly with an existing `server.enhanceMiddleware`: requests under
 * the basePath are handled by serve-sim, anything else falls through to the
 * downstream Metro middleware via `next()` — no `connect` dependency needed.
 * Start `serve-sim` separately with `serve-sim --detach`.
 */
export function withSimServe<T extends MetroLikeConfig>(
  config: T,
  options?: ExpoServeSimOptions,
): T {
  if (!config.server) {
    (config as MetroLikeConfig).server = {};
  }
  const server = config.server!;
  const originalEnhanceMiddleware = server.enhanceMiddleware;
  const sim = simMiddleware(options);

  server.enhanceMiddleware = (metroMiddleware, metroServer) => {
    const wrapped: ConnectMiddleware = (req, res, next) => {
      sim(req, res, () => metroMiddleware(req, res, next));
    };
    return originalEnhanceMiddleware
      ? originalEnhanceMiddleware(wrapped, metroServer)
      : wrapped;
  };

  return config;
}

export type { SimMiddlewareOptions };
