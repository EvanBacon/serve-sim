/**
 * Which serve-sim tests need a Darwin runner (booted sim and/or native helper)
 * vs which can run with full concurrency on Ubuntu.
 *
 * Paths are repo-root-relative so GitHub Actions `paths:` filters and
 * `bun test` invocations stay in lockstep (see ci-test-plan.test.ts).
 */
export const SIM_E2E_TEST_FILES = [
  "packages/serve-sim/src/__tests__/accessibility-endpoint.test.ts",
  "packages/serve-sim/src/__tests__/avcc-stream-endpoint.test.ts",
  "packages/serve-sim/src/__tests__/camera-connections.e2e.test.ts",
  "packages/serve-sim/src/__tests__/hid-malformed-input.test.ts",
  "packages/serve-sim/src/__tests__/idle-floor.test.ts",
  "packages/serve-sim/src/__tests__/permissions.e2e.test.ts",
  "packages/serve-sim/src/__tests__/type-command-sim.test.ts",
  "packages/serve-sim/src/__tests__/ui-settings.e2e.test.ts",
] as const;

/**
 * Shuts its simulator down and boots it again, so it is opt-in
 * (SERVE_SIM_E2E_SHUTDOWN_UDID). The runner runs it after every other Darwin
 * test, opted in on the CI-owned simulator, which the workflow shuts down
 * afterwards anyway.
 */
export const SIM_SHUTDOWN_E2E_TEST_FILE =
  "packages/serve-sim/src/__tests__/hid-after-shutdown.e2e.test.ts";

export const DARWIN_INTEGRATION_TEST_FILES = [
  "packages/serve-sim/src/__tests__/shm-probe.integration.test.ts",
  "packages/serve-sim/src/__tests__/duo-renderer.integration.test.ts",
  "packages/serve-sim/src/__tests__/record-inspect.integration.test.ts",
] as const;

const DARWIN_TEST_FILE_SET = new Set<string>([
  ...SIM_E2E_TEST_FILES,
  ...DARWIN_INTEGRATION_TEST_FILES,
  SIM_SHUTDOWN_E2E_TEST_FILE,
]);

export function isDarwinTestFile(file: string): boolean {
  return DARWIN_TEST_FILE_SET.has(normalizeRepoPath(file));
}

/** Paths that should not, by themselves, spend a macOS e2e slot. */
export function isDarwinSkipPath(file: string): boolean {
  const normalized = normalizeRepoPath(file);
  if (normalized.endsWith(".md")) return true;
  if (normalized.startsWith("packages/serve-sim/src/client/")) return true;
  if (normalized.startsWith("packages/serve-sim/docs/")) return true;
  if (normalized.startsWith("packages/serve-sim/src/__tests__/")) {
    return !isDarwinTestFile(normalized);
  }
  return false;
}

export function needsDarwinE2E(changedFiles: string[]): boolean {
  if (changedFiles.length === 0) return true;
  return changedFiles.some((file) => !isDarwinSkipPath(file));
}

/**
 * One-line summary of `udid` from `simctl list devices -j` output, logged by
 * the CI runner when a reboot step fails so the log shows the real state.
 */
export function describeSimulatorState(listJson: string, udid: string): string {
  let devices: Record<string, Array<{ udid?: string; state?: string; isAvailable?: boolean }>>;
  try {
    devices = (JSON.parse(listJson) as { devices: typeof devices }).devices ?? {};
  } catch {
    return `${udid} state unknown (unparseable simctl list output: ${listJson.slice(0, 200).trim()})`;
  }
  for (const [runtime, list] of Object.entries(devices)) {
    const device = Array.isArray(list) ? list.find((d) => d?.udid === udid) : undefined;
    if (device) return `${udid} state=${device.state} isAvailable=${device.isAvailable} runtime=${runtime}`;
  }
  return `${udid} not listed by simctl`;
}

function normalizeRepoPath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}
