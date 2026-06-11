import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { DeviceLogsTool } from "./device-logs-tool";

export function DeviceLogsPanel({
  open,
  onClose,
  udid,
  currentApp,
  logsEndpoint,
  width,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
  logsEndpoint?: string;
  width: number;
}) {
  return (
    <Panel open={open} width={width}>
      <PanelHeader>
        <PanelTitle>Device Logs</PanelTitle>
        <PanelCloseButton
          onClick={onClose}
          ariaLabel="Close Device Logs"
          title="Close"
          iconSize={15}
        />
      </PanelHeader>

      {open && (
        <div className="p-3.5 overflow-hidden flex-1 flex flex-col">
          <DeviceLogsTool
            udid={udid}
            currentApp={currentApp}
            logsEndpoint={logsEndpoint}
          />
        </div>
      )}
    </Panel>
  );
}
