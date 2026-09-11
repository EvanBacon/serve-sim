/**
 * Native artifact architecture for camera injector/helper, ax-settings, and
 * SimNative. Default is universal (arm64 + x86_64) so `bun run build.ts` and
 * npm publish ship a fat tarball. CI test jobs set `SERVE_SIM_ARCH=arm64`.
 */
export const SERVE_SIM_ARCH_VALUES = ["arm64", "x86_64", "universal"] as const;
export type ServeSimArch = (typeof SERVE_SIM_ARCH_VALUES)[number];

export function parseServeSimArch(value: string | undefined = process.env.SERVE_SIM_ARCH): ServeSimArch {
  const raw = value === undefined || value === "" ? "universal" : value;
  if (raw === "arm64" || raw === "x86_64" || raw === "universal") return raw;
  throw new Error(`SERVE_SIM_ARCH must be arm64, x86_64, or universal (got ${JSON.stringify(value)})`);
}

export function clangArchArgs(arch: ServeSimArch): string[] {
  switch (arch) {
    case "arm64":
      return ["-arch", "arm64"];
    case "x86_64":
      return ["-arch", "x86_64"];
    case "universal":
      return ["-arch", "arm64", "-arch", "x86_64"];
  }
}

export function swiftArchArgs(arch: ServeSimArch): string[] {
  switch (arch) {
    case "arm64":
      return ["--arch", "arm64"];
    case "x86_64":
      return ["--arch", "x86_64"];
    case "universal":
      return ["--arch", "arm64", "--arch", "x86_64"];
  }
}
