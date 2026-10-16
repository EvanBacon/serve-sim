/// SimulatorKit can fire a frame callback before the framebuffer IOSurface's
/// seed reflects the new frame (~13% of callbacks in measurement; the seed
/// moved 1–16 ms later). Capture used to read the seed only after ~5 ms of
/// per-frame XPC, which hid this. Without a re-check such a frame isn't
/// emitted until the next idle tick (up to 200 ms later), so a callback that
/// finds the seed unchanged re-checks on this schedule.
public enum SeedRecheckSchedule {
    static let delaysMs = [1, 1, 2, 4, 8, 16]

    /// Delay before re-check number `attempt` (0-based), or nil to give up.
    public static func delayMs(afterAttempt attempt: Int) -> Int? {
        delaysMs.indices.contains(attempt) ? delaysMs[attempt] : nil
    }
}
