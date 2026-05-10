export function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      className={`lem-chevron text-white/50 [transition:transform_0.15s,color_0.12s] ${open ? "rotate-180" : "rotate-0"}`}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function ArrowGlyph({ dir }: { dir: "up" | "down" }) {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className="mr-[3px]">
      {dir === "up" ? <polygon points="12,4 20,18 4,18" /> : <polygon points="4,6 20,6 12,20" />}
    </svg>
  );
}
