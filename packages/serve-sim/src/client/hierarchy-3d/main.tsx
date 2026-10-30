// Entry for the experimental /hierarchy-3d page (`--experimental-hierarchy-3d`).
// Bundled separately from the main preview client (build.ts inlines it with
// hierarchy-3d.css) so it costs nothing unless the page is opened.
import { createRoot } from "react-dom/client";
import { App, type Hierarchy3dConfig } from "./app";

declare global {
  interface Window {
    __SIM_HIERARCHY_3D__?: Hierarchy3dConfig;
  }
}

const config: Hierarchy3dConfig = window.__SIM_HIERARCHY_3D__ ?? { basePath: "", device: null };
createRoot(document.getElementById("root")!).render(<App config={config} />);
