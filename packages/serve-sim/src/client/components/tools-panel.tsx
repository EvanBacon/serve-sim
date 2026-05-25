import { LocationEmulationTool } from "../location-emulation-tool";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { execOnHost } from "../utils/exec";
import { AppDetectionTool } from "./app-detection-tool";
import { AppPermissionsTool } from "./app-permissions-tool";
import { AxTreeTool } from "./ax-tree-tool";
import { CameraTool } from "./camera-tool";
import type { DevicePlatform } from "./platform-badge";

export function ToolsPanel({
  open,
  onClose,
  udid,
  currentApp,
  platform = "ios",
  axOverlayEnabled,
  onToggleAxOverlay,
  width,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
  platform?: DevicePlatform;
  axOverlayEnabled: boolean;
  onToggleAxOverlay: () => void;
  width: number;
}) {
  const isAndroid = platform === "android";
  const supportsLocation = platform === "ios" || udid.startsWith("emulator-");

  return (
    <Panel open={open} width={width}>
      <PanelHeader>
        <PanelTitle>Tools</PanelTitle>
        <PanelCloseButton onClick={onClose} />
      </PanelHeader>

      {open && (
        <div className="p-3.5 overflow-y-auto flex-1 flex flex-col gap-3">
          <AppDetectionTool udid={udid} currentApp={currentApp} platform={platform} />
          {!isAndroid && (
            <AxTreeTool
              overlayEnabled={axOverlayEnabled}
              onToggleOverlay={onToggleAxOverlay}
            />
          )}
          {!isAndroid && <CameraTool udid={udid} bundleId={currentApp?.bundleId ?? null} />}
          {supportsLocation && <LocationEmulationTool udid={udid} exec={execOnHost} platform={platform} />}
          {!isAndroid && <AppPermissionsTool udid={udid} bundleId={currentApp?.bundleId ?? null} />}
        </div>
      )}
    </Panel>
  );
}
