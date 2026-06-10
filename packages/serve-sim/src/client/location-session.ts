// Pure helpers backing a trail-playback "session". The tool component holds
// the live refs/state; these helpers encode just the decisions:
//
//   - What lat/lng counts as the session origin (where to restore on stop).
//   - How to format the simctl command that ends the session.
//
// Keeping these as pure functions lets us regression-test the bug they fix:
// the play handler used to capture the *trail's* first point as the origin,
// which meant stopping sent the simulator to the trail start (e.g. Apple
// Park) instead of back to wherever the user had pinned beforehand.

export type SimLocation = { lat: number; lng: number };

/** The lat/lng to restore when a trail-playback session ends.
 *
 *  In serve-sim the only ways the simulator's location changes are (a) the
 *  user pins one manually via the Pin Location input, or (b) a trail-playback
 *  session streams updates. (b) is what we're ending — so the location to
 *  restore is whatever (a) set last, NOT a point on the trail. If the user
 *  never pinned anything, returns null and the caller should `clear`. */
export function pickSessionOrigin(
  lastPinned: SimLocation | null,
): SimLocation | null {
  return lastPinned;
}

/** Build the simctl command that ends a session — restoring to `origin`
 *  when one is supplied, otherwise clearing the simulated location. */
export function buildEndSessionCommand(
  udid: string,
  origin: SimLocation | null,
): string {
  if (origin) {
    return `xcrun simctl location ${udid} set ${origin.lat.toFixed(7)},${origin.lng.toFixed(7)}`;
  }
  return `xcrun simctl location ${udid} clear`;
}
