/// Places captured simulator frames on a constant-frame-rate grid for screen
/// recordings.
///
/// SimulatorKit only fires a frame callback when the screen changes, so the
/// raw capture is variable-rate: ~60 fps while scrolling, nothing at all while
/// the screen is static, and jittered by a few ms either way. A recording
/// stamped with raw capture times plays back fine in some players, but editors
/// and browsers handle sparse VFR poorly and tooling reports a meaningless
/// frame rate. Instead each frame is snapped to the nearest slot of a fixed
/// `fps` grid measured from the first frame's capture time, and empty slots
/// are filled by repeating the previous frame (cheap: H.264/HEVC encode an
/// unchanged frame as skip blocks). The result is true CFR whose motion timing
/// still follows the actual capture clock, not frame arrival order.
///
/// Jitter handling: SimulatorKit often delivers frames in bursts (two or
/// three distinct frames a couple of ms apart after a compositor hiccup), so a
/// frame whose rounded slot is already taken moves to the next free slot as
/// long as that keeps it less than `maxLag` frame intervals behind its real
/// capture time. A few frames of lag is invisible in a recording and catches
/// up at the next pause; a dropped frame is a visible stutter. Only a source
/// that sustains more than `fps` (e.g. a 120 Hz burst) falls further behind,
/// and those frames are dropped rather than letting the timeline drift.
public struct RecordingFrameScheduler: Sendable {
    /// Where to append a captured frame.
    public struct Placement: Equatable, Sendable {
        /// Slots to fill with the previously appended frame first, in order.
        public let repeats: Range<Int64>
        /// Slot (presentation time = slot / fps) for the new frame.
        public let slot: Int64
    }

    /// Frame intervals a frame may be placed after its capture time.
    public static let defaultMaxLag = 3.0

    public let fps: Int
    public let maxLag: Double
    private var origin: Double?
    private var lastSlot: Int64 = -1

    public init(fps: Int, maxLag: Double = defaultMaxLag) {
        precondition(fps > 0, "fps must be positive")
        precondition(maxLag >= 1, "maxLag must allow at least the next slot")
        self.fps = fps
        self.maxLag = maxLag
    }

    /// Number of slots written so far (the next free slot).
    public var slotCount: Int64 { lastSlot + 1 }

    /// Place a frame captured at `time` (seconds on a monotonic clock). Returns
    /// nil when the frame should be dropped.
    public mutating func place(captureTime time: Double) -> Placement? {
        guard let origin else {
            self.origin = time
            lastSlot = 0
            return Placement(repeats: 0..<0, slot: 0)
        }
        let exact = (time - origin) * Double(fps)
        var slot = Int64(exact.rounded())
        if slot <= lastSlot {
            // Nudge a jittered/bursty frame into the next slot, but never
            // more than `maxLag` intervals after it was really captured.
            let next = lastSlot + 1
            guard Double(next) - exact < maxLag else { return nil }
            slot = next
        }
        let repeats = (lastSlot + 1)..<slot
        lastSlot = slot
        return Placement(repeats: repeats, slot: slot)
    }

    /// Slots to fill with the last frame so the recording runs until `time`,
    /// plus the end time (in slots) to close the session at. Nil when no frame
    /// was ever placed.
    public mutating func finish(at time: Double) -> (repeats: Range<Int64>, endSlot: Int64)? {
        guard let origin else { return nil }
        let target = Int64(((time - origin) * Double(fps)).rounded(.down))
        let repeats = (lastSlot + 1)..<max(lastSlot + 1, target + 1)
        if let last = repeats.last { lastSlot = last }
        return (repeats, lastSlot + 1)
    }
}
