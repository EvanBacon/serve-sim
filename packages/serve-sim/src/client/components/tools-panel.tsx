import { LocationEmulationTool } from "../location-emulation-tool";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { hostAction } from "../utils/exec";
import { AppDetectionTool } from "./app-detection-tool";
import { AppPermissionsTool } from "./app-permissions-tool";
import { AxTreeTool } from "./ax-tree-tool";
import { CameraTool } from "./camera-tool";
import { ClipboardTool } from "./clipboard-tool";
import { EventLogTool } from "./event-log-tool";
import { PANEL_BACKGROUND } from "./panel-colors";
import { SimulatorSettingsTool } from "./simulator-settings-tool";
import { StreamSettingsTool, type CodecPreference } from "./stream-settings-tool";

export function ToolsPanel({
  open,
  onClose,
  udid,
  deviceRuntime,
  currentApp,
  eventLogEventsEndpoint,
  axOverlayEnabled,
  onToggleAxOverlay,
  codecPreference,
  onCodecPreferenceChange,
  activeCodec,
  avccSupported,
  chromeAvailable = false,
  hideChrome = false,
  onHideChromeChange,
  width,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  deviceRuntime: string | null;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
  eventLogEventsEndpoint?: string;
  axOverlayEnabled: boolean;
  onToggleAxOverlay: () => void;
  codecPreference: CodecPreference;
  onCodecPreferenceChange: (next: CodecPreference) => void;
  activeCodec: "h264" | "mjpeg";
  avccSupported: boolean;
  chromeAvailable?: boolean;
  hideChrome?: boolean;
  onHideChromeChange?: (next: boolean) => void;
  width: number;
}) {
  return (
    <Panel open={open} width={width} style={{ backgroundColor: PANEL_BACKGROUND }}>
      <PanelHeader>
        <PanelTitle>Tools</PanelTitle>
        <PanelCloseButton onClick={onClose} />
      </PanelHeader>

      {open && (
        <div className="p-3.5 overflow-y-auto flex-1 flex flex-col gap-3">
          <AppDetectionTool udid={udid} currentApp={currentApp} />
          <ClipboardTool udid={udid} />
          <EventLogTool udid={udid} eventsEndpoint={eventLogEventsEndpoint} />
          <SimulatorSettingsTool udid={udid} runtime={deviceRuntime} />
          <AxTreeTool
            overlayEnabled={axOverlayEnabled}
            onToggleOverlay={onToggleAxOverlay}
          />
          <CameraTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
          <LocationEmulationTool udid={udid} host={hostAction} />
          <AppPermissionsTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
          <StreamSettingsTool
            preference={codecPreference}
            onPreferenceChange={onCodecPreferenceChange}
            activeCodec={activeCodec}
            avccSupported={avccSupported}
            chromeAvailable={chromeAvailable}
            hideChrome={hideChrome}
            onHideChromeChange={onHideChromeChange}
          />
        </div>
      )}
    </Panel>
  );
}
