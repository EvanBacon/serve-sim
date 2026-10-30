/**
 * Optional cap on the H.264 preview bitrate. The native encoder scales its
 * average bitrate with the screen's pixel rate (6–30 Mbps); this clamps that
 * for slow links or shared hosts. Unset keeps the default behavior.
 */
export const MAX_BITRATE_ENV = "SERVE_SIM_MAX_BITRATE";

const MAX_MBPS = 1000;

/** Parse a positive Mbps value (fractions allowed). Throws on anything else. */
export function parseMaxBitrateMbps(value: string): number {
  const trimmed = value.trim();
  const mbps = /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(mbps) || mbps <= 0 || mbps > MAX_MBPS) {
    throw new Error(`Invalid max bitrate '${value}': expected Mbps between 0 and ${MAX_MBPS} (e.g. 8 or 2.5).`);
  }
  return mbps;
}

/** The cap in bits/s from SERVE_SIM_MAX_BITRATE, or undefined when unset/invalid. */
export function maxBitrateFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): number | undefined {
  const raw = env[MAX_BITRATE_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    return Math.round(parseMaxBitrateMbps(raw) * 1_000_000);
  } catch (error) {
    warn(`[serve-sim] Ignoring ${MAX_BITRATE_ENV}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Hand `--max-bitrate` to the in-process capture (and to a --detach child,
 * which inherits the environment) the same way the auth token travels.
 */
export function applyMaxBitrateOption(mbps: number | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (mbps !== undefined) env[MAX_BITRATE_ENV] = String(mbps);
}
