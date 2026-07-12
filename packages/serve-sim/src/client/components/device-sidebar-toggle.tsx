import { PanelLeft } from "lucide-react";
import { ServeSimBrandLink } from "./serve-sim-brand-link";

export function DeviceSidebarToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <div
      className={`fixed top-3 left-3 z-30 flex items-center gap-1 p-1 [transition:opacity_0.18s_ease] ${open ? "opacity-0 pointer-events-none" : "opacity-100 pointer-events-auto"}`}
    >
      <button
        onClick={onClick}
        className="w-[30px] h-[30px] flex items-center justify-center bg-transparent border-none rounded-md text-[#8e8e93] cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
        aria-label="Open devices sidebar"
        aria-pressed={open}
        title="Devices"
      >
        <PanelLeft size={18} strokeWidth={1.75} />
      </button>
      <ServeSimBrandLink />
    </div>
  );
}
