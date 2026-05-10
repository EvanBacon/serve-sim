export function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      className="lem-chevron"
      style={{ transition: "transform 0.15s, color 0.12s", transform: open ? "rotate(180deg)" : "rotate(0deg)", color: "rgba(255,255,255,0.5)" }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function ArrowGlyph({ dir }: { dir: "up" | "down" }) {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"
      style={{ marginRight: 3 }}>
      {dir === "up" ? <polygon points="12,4 20,18 4,18" /> : <polygon points="4,6 20,6 12,20" />}
    </svg>
  );
}
