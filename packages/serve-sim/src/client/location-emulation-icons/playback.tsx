export function PlayGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="6,4 20,12 6,20" />
    </svg>
  );
}

export function PauseGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

export function StopGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  );
}

export function FastForwardGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z" />
      <path d="M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z" />
    </svg>
  );
}
