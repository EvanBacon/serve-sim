import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceSidebarToggle } from "../client/components/device-sidebar-toggle";
import { SERVE_SIM_REPO_URL } from "../client/components/serve-sim-brand-link";

const noop = () => {};

describe("DeviceSidebarToggle", () => {
  test("keeps serve-sim branding under the collapsed sidebar position", () => {
    const html = renderToStaticMarkup(<DeviceSidebarToggle open={false} onClick={noop} />);

    expect(html).toContain("top-3");
    expect(html).toContain("left-3");
    expect(html).toContain("z-30");
    expect(html).toContain("flex items-center");
    expect(html).toContain("serve-sim");
    expect(html).toContain("text-white/65");
    expect(html).toContain(`href="${SERVE_SIM_REPO_URL}"`);
    expect(html).not.toContain("max-[900px]:hidden");
  });
});
