import { useState } from "react";
import { CollapsibleSection } from "./collapsible-section";
import { Select } from "./select";

// Client-side video preference. "auto" decodes H.264 (AVCC via WebCodecs) when
// the browser supports it; "mjpeg" forces the software JPEG path. H.264 decode
// runs through the GPU's VideoToolbox pipeline, which a concurrent screen
// recorder (Screen Studio, QuickTime, …) can starve — producing stutter and
// reconnect loops. MJPEG decodes in software and is immune to that contention,
// so it's the escape hatch when recording the browser window.
export type CodecPreference = "auto" | "mjpeg";

export const CODEC_PREFERENCE_STORAGE_KEY = "serve-sim:codec";

const CODEC_OPTIONS = [
  { value: "auto", label: "H.264 (Hardware)" },
  { value: "mjpeg", label: "MJPEG (Compatibility)" },
];

// Inline 14px glyph, stroked at full opacity (no dimmed icons).
const VideoIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
    <rect x="2" y="6" width="14" height="12" rx="2" />
  </svg>
);

export function StreamSettingsTool({
  preference,
  onPreferenceChange,
  activeCodec,
  avccSupported,
}: {
  /** The user's saved codec preference. */
  preference: CodecPreference;
  onPreferenceChange: (next: CodecPreference) => void;
  /** The codec actually painting frames right now. */
  activeCodec: "h264" | "mjpeg";
  /** Whether this browser can decode H.264 (WebCodecs available). */
  avccSupported: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Without WebCodecs the only option is MJPEG; reflect that in the control so
  // it never reads as if H.264 were a live choice.
  const value: CodecPreference = avccSupported ? preference : "mjpeg";
  // Auto resolved to MJPEG (startup fallback or a helper that doesn't serve
  // /stream.avcc) — surface it so the picker doesn't lie about what's on screen.
  const downgraded = avccSupported && preference === "auto" && activeCodec === "mjpeg";

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      data-stream-settings=""
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Stream
          </span>
          <span />
        </>
      }
    >
      <div className="flex flex-col gap-1.5 pb-1.5">
        <div className="flex items-center justify-between gap-2 min-h-[30px]" data-setting-row="Codec">
          <span className="flex shrink-0 items-center gap-2 text-[12px] text-white/90 whitespace-nowrap">
            <span className="flex size-[18px] items-center justify-center text-white">{VideoIcon}</span>
            Codec
          </span>
          <span className="flex min-w-0 justify-end">
            <Select
              label="Codec"
              value={value}
              options={CODEC_OPTIONS}
              disabled={!avccSupported}
              onChange={(v) => onPreferenceChange(v as CodecPreference)}
              className="bg-white/[0.06] border border-white/10 rounded-md text-white/90 text-[12px] py-0.5 px-2 min-w-0 max-w-[150px] disabled:text-white/40"
            />
          </span>
        </div>
        <p className="text-[11px] text-white/55 leading-snug px-0.5">
          {!avccSupported
            ? "This browser can't decode H.264, so the stream uses MJPEG."
            : downgraded
              ? "H.264 was unavailable for this stream, so it fell back to MJPEG."
              : "Switch to MJPEG if the stream stutters or drops while screen recording the browser window."}
        </p>
      </div>
    </CollapsibleSection>
  );
}
