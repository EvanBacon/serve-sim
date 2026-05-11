import { Panel, PanelCloseButton, PanelHeader } from "../Panel";
import {
  collapseScreencastPane,
  type WebKitDevtoolsTarget,
} from "../utils/devtools";
import { WebKitTargetPicker } from "./webkit-target-picker";

export function WebKitDevtoolsPanel({
  open,
  onClose,
  udid,
  targets,
  selectedTargetId,
  onSelectTarget,
  loading,
  error,
  onRefresh,
  width,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  targets: WebKitDevtoolsTarget[];
  selectedTargetId: string | null;
  onSelectTarget: (id: string) => void;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  width: number;
}) {
  const selected = selectedTargetId
    ? targets.find((target) => target.id === selectedTargetId) ?? null
    : null;

  return (
    <Panel open={open} width={width}>
      <PanelHeader>
        {targets.length > 0 ? (
          <WebKitTargetPicker
            udid={udid}
            targets={targets}
            selected={selected}
            onSelectTarget={onSelectTarget}
            onRefresh={onRefresh}
          />
        ) : (
          <span className="text-[12px] text-white/[0.48] overflow-hidden text-ellipsis whitespace-nowrap">
            {loading ? "Looking for Safari and inspectable webviews..." : "No inspectable Safari or WKWebView targets"}
          </span>
        )}
        <PanelCloseButton
          onClick={onClose}
          ariaLabel="Close WebKit DevTools"
          title="Close"
          iconSize={15}
        />
      </PanelHeader>

      <div className="flex-1 min-h-0 bg-white relative">
        {error ? (
          <div className="h-full flex items-center justify-center p-6 bg-panel-deep text-white/[0.58] text-center text-[13px]">{error}</div>
        ) : selected && open ? (
          // Mount the iframe only while the panel is visible. Unmounting tears
          // down the WebSocket so WIR releases the page; otherwise we'd hold
          // the inspector connection forever and block other debuggers (Safari
          // Develop menu, chrome://inspect, …) from attaching.
          <iframe
            key={selected.id}
            src={selected.devtoolsFrontendUrl}
            title={`WebKit DevTools - ${selected.title || selected.url || selected.id}`}
            className="w-full h-full border-none block bg-white"
            onLoad={(event) => collapseScreencastPane(event.currentTarget)}
          />
        ) : (
          <div className="h-full flex items-center justify-center p-6 bg-panel-deep text-white/[0.58] text-center text-[13px]">
            {selected
              ? "DevTools paused — open the panel to reattach."
              : "Open Safari or an inspectable WKWebView in the simulator."}
          </div>
        )}
      </div>
    </Panel>
  );
}
