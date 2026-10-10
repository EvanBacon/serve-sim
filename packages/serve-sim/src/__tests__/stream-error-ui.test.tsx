import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamStatusPill } from "../client/components/stream-status-pill";
import { copyDiagnostics, StreamErrorPanel } from "../client/components/stream-error-panel";

const error = {
  status: 503,
  error: "duo_renderer_unavailable",
  reason: "The selected Xcode does not include the iPhone Duo 3D model.",
  stage: "model_lookup",
  retryInMs: 4000,
};

describe("stream error UI", () => {
  test("the status pill shows the failing stage instead of connecting", () => {
    const html = renderToStaticMarkup(<StreamStatusPill streaming={false} error={error} />);
    expect(html).toContain("error · model_lookup");
    expect(html).toContain('title="The selected Xcode does not include the iPhone Duo 3D model."');
    expect(html).not.toContain("connecting");
    expect(renderToStaticMarkup(<StreamStatusPill streaming error={error} />)).toContain(">live</span>");
    expect(renderToStaticMarkup(<StreamStatusPill streaming={false} error={{ status: 0, error: "no_response", reason: "x" }} />)).toContain("error · no response");
  });

  test("the inline panel shows the reason, stage, retry, and a copy button", () => {
    const html = renderToStaticMarkup(<StreamErrorPanel title="3D view unavailable" error={error} diagnosticsEndpoint="/api/diagnostics" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("does not include the iPhone Duo 3D model");
    expect(html).toContain("stage=model_lookup");
    expect(html).toContain("Retrying in 4s.");
    expect(html).toContain("Copy diagnostics");
  });

  test("copy diagnostics copies the doctor JSON and explains the loopback guard", async () => {
    const copied: string[] = [];
    const ok = await copyDiagnostics("/api/diagnostics?device=X", async (text) => { copied.push(text); },
      (async () => new Response('{"schema_version":1}', { status: 200 })) as unknown as typeof fetch);
    expect(ok).toBe("Copied diagnostics JSON.");
    expect(copied).toEqual(['{"schema_version":1}']);
    const denied = await copyDiagnostics("/api/diagnostics", async () => { throw new Error("must not copy"); },
      (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch);
    expect(denied).toContain("serve-sim doctor --json");
  });
});
