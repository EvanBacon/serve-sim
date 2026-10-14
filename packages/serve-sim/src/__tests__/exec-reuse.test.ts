import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { statSync } from "fs";
import {
  authTokenFingerprint,
  parseDeviceState,
  reuseAuthMismatch,
  reuseExecMismatch,
} from "../helper-lifecycle";
import {
  EXEC_TOKEN_DIR,
  execTokenFileForPort,
  inProcessServeSimState,
  readExecTokenFile,
  removeExecTokenFile,
  writeExecTokenFile,
} from "../state";

const UDID = "11111111-2222-3333-4444-555555555555";

describe("--detach / follow reuse checks the auth-token fingerprint", () => {
  const stateFor = (token?: string) => ({
    ...inProcessServeSimState(UDID, 3200),
    ...(token ? { authTokenSha256: authTokenFingerprint(token) } : {}),
  });

  test("the fingerprint is sha256 hex, never the raw token", () => {
    const fp = authTokenFingerprint("s3cret")!;
    expect(fp).toBe(createHash("sha256").update("s3cret").digest("hex"));
    expect(fp).not.toContain("s3cret");
    expect(authTokenFingerprint(undefined)).toBeUndefined();
  });

  test("the fingerprint survives the state-file round trip", () => {
    const parsed = parseDeviceState(JSON.stringify(stateFor("s3cret")));
    expect(parsed?.authTokenSha256).toBe(authTokenFingerprint("s3cret"));
  });

  test("same token (or none on both sides) may reuse", () => {
    expect(reuseAuthMismatch(stateFor("s3cret"), "s3cret")).toBeNull();
    expect(reuseAuthMismatch(stateFor(), undefined)).toBeNull();
  });

  test("a different token is refused with a kill hint", () => {
    const message = reuseAuthMismatch(stateFor("old-token"), "new-token");
    expect(message).toContain("different --auth-token");
    expect(message).toContain(`serve-sim -k ${UDID}`);
  });

  test("a server without a token is not reused when one is requested", () => {
    const message = reuseAuthMismatch(stateFor(), "new-token");
    expect(message).toContain("without an --auth-token");
    expect(message).toContain(`serve-sim -k ${UDID}`);
  });

  test("a token-guarded server is not reused when none is requested", () => {
    expect(reuseAuthMismatch(stateFor("old-token"), undefined)).toContain(`serve-sim -k ${UDID}`);
  });
});

describe("--detach / follow reuse checks the --allow-exec opt-in", () => {
  const stateFor = (allowExec?: boolean) => ({
    ...inProcessServeSimState(UDID, 3200),
    ...(allowExec ? { allowExec: true } : {}),
  });

  test("the opt-in survives the state-file round trip", () => {
    expect(parseDeviceState(JSON.stringify(stateFor(true)))?.allowExec).toBe(true);
    expect(parseDeviceState(JSON.stringify(stateFor()))?.allowExec).toBeUndefined();
  });

  test("a matching opt-in (on/on, off/off) may reuse", () => {
    expect(reuseExecMismatch(stateFor(true), true)).toBeNull();
    expect(reuseExecMismatch(stateFor(), false)).toBeNull();
  });

  test("an exec-enabled server is not reused when exec was not requested", () => {
    const message = reuseExecMismatch(stateFor(true), false);
    expect(message).toContain("was started with --allow-exec");
    expect(message).toContain(`serve-sim -k ${UDID}`);
  });

  test("an exec-disabled server is not reused when --allow-exec was requested", () => {
    const message = reuseExecMismatch(stateFor(), true);
    expect(message).toContain("was started without --allow-exec");
    expect(message).toContain(`serve-sim -k ${UDID}`);
  });
});

describe("serve-sim exec quotes each argv word", () => {
  test("metacharacters in an argument stay literal", async () => {
    const { shellJoin } = await import("../shell-quote");
    const { execFileSync } = await import("child_process");
    const argv = ["printf", "%s|", "a b", "$(echo injected)", "it's", "; echo nope"];
    const out = execFileSync("sh", ["-c", shellJoin(argv)], { encoding: "utf-8" });
    expect(out).toBe("a b|$(echo injected)|it's|; echo nope|");
  });
});

describe("exec token file", () => {
  // A port nothing in the suite binds, so a real server's file isn't touched.
  const PORT = 65_431;
  afterAll(() => removeExecTokenFile(PORT));

  test("is owner-only (dir 0700, file 0600) and round-trips", () => {
    const file = writeExecTokenFile(PORT, "file-token");
    expect(file).toBe(execTokenFileForPort(PORT));
    expect(statSync(EXEC_TOKEN_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readExecTokenFile(PORT)).toBe("file-token");
    removeExecTokenFile(PORT);
    expect(readExecTokenFile(PORT)).toBeNull();
  });
});
