import { LocationEmulationTool } from "../location-emulation-tool";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { execOnHost } from "../utils/exec";
import { AppDetectionTool } from "./app-detection-tool";
import { AppPermissionsTool } from "./app-permissions-tool";
import { AxTreeTool } from "./ax-tree-tool";
import { CameraTool } from "./camera-tool";

export function ToolsPanel({
  open,
  onClose,
  udid,
  currentApp,
  axOverlayEnabled,
  onToggleAxOverlay,
  width,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
  axOverlayEnabled: boolean;
  onToggleAxOverlay: () => void;
  width: number;
}) {
  return (
    <Panel open={open} width={width}>
      <PanelHeader>
        <PanelTitle>Tools</PanelTitle>
        <PanelCloseButton onClick={onClose} />
      </PanelHeader>

      {open && (
        <div className="p-3.5 overflow-y-auto flex-1 flex flex-col gap-3">
          <AppDetectionTool udid={udid} currentApp={currentApp} />
          <AxTreeTool
            overlayEnabled={axOverlayEnabled}
            onToggleOverlay={onToggleAxOverlay}
          />
          <CameraTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
          <LocationEmulationTool udid={udid} exec={execOnHost} />
          <AppPermissionsTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
        </div>
      )}
    </Panel>
  );
}
