/// Per-slot metadata for a screen recording, collected as the recorder
/// appends samples and shipped with the finish summary so the JS side can
/// write a `<name>.index.jsonl` sidecar next to the MP4.
///
/// One entry per sample actually appended to the writer, in order: its slot
/// (pts = slot / fps), the capture uptime of the frame whose pixels it holds
/// (repeats carry their source frame's time), and whether its pixels differ
/// from the previously appended sample. Only collected when the recording
/// was started with `index` (`serve-sim record` without `--no-index`).
///
/// Memory: three flat arrays, 13 bytes of payload per entry (~1.4 MB for
/// 30 min at 60 fps), but they grow by doubling without `reserveCapacity`,
/// so the resident size can reach about twice that just after a growth.
/// Appending is amortised O(1), so it doesn't slow the recorder queue. The
/// bigger cost is at finish: `jsonObject` builds `[Int]` copies that are
/// bridged to `NSNumber`s for serialisation (tens of bytes each, so tens of
/// MB transiently for a 30 min recording) plus the JSON text itself (a few
/// MB). That's once per indexed recording, on the recorder queue.
/// `capacity` bounds all of it; past it entries are dropped and `truncated`
/// is set (the MP4 is unaffected).
public struct RecordingFrameIndex: Sendable {
    /// The captured frame behind a sample.
    public struct Source: Equatable, Sendable {
        /// Distinguishes captured frames (the recorder's capture counter).
        public let sequence: UInt64
        /// Monotonic capture time (uptime seconds).
        public let captureTime: Double
        /// Surface identity + seed when capture read it; nil when unknown.
        public let stamp: SurfaceFrameStamp?

        public init(sequence: UInt64, captureTime: Double, stamp: SurfaceFrameStamp?) {
            self.sequence = sequence
            self.captureTime = captureTime
            self.stamp = stamp
        }
    }

    /// 30 min at the 120 fps maximum, with headroom.
    public static let defaultCapacity = 1 << 18

    public let capacity: Int
    public private(set) var slots: [UInt32] = []
    public private(set) var uptimes: [Double] = []
    public private(set) var changed: [Bool] = []
    public private(set) var truncated = false
    private var lastWritten: Source?

    public init(capacity: Int = defaultCapacity) {
        precondition(capacity >= 0, "capacity must not be negative")
        self.capacity = capacity
    }

    public var count: Int { slots.count }

    /// Record a sample appended at `slot` holding `source`'s pixels.
    ///
    /// Changed is measured against the previously appended sample, not the
    /// previously captured frame: a captured frame whose own slot write
    /// failed still becomes the repeat source, so its first written repeat
    /// is where the change shows up in the file. A new captured frame with
    /// the same surface stamp (FrameCapture's idle re-emit) is unchanged.
    public mutating func recordWrite(slot: Int64, source: Source) {
        let isChanged: Bool
        if let last = lastWritten {
            if last.sequence == source.sequence {
                isChanged = false
            } else if let stamp = source.stamp, stamp == last.stamp {
                isChanged = false
            } else {
                isChanged = true
            }
        } else {
            isChanged = true
        }
        lastWritten = source
        guard slots.count < capacity, slot >= 0, slot <= Int64(UInt32.max) else {
            truncated = true
            return
        }
        slots.append(UInt32(slot))
        uptimes.append(source.captureTime)
        changed.append(isChanged)
    }

    /// JSON-serializable form for the native finish summary. Uptimes are
    /// integer microseconds (exact as JS numbers, smaller than doubles);
    /// `changed` is 0/1. `clock` carries the samples the JS side needs to
    /// join event-log wall-clock times onto the media timeline:
    /// `originUptime` (capture uptime at pts 0), and `armedUptime` /
    /// `armedWallMs` sampled back to back when the recorder was created.
    public func jsonObject(fps: Int, originUptime: Double?, armedUptime: Double, armedWallMs: Double) -> [String: Any] {
        var clock: [String: Double] = ["armedUptime": armedUptime, "armedWallMs": armedWallMs]
        if let originUptime { clock["originUptime"] = originUptime }
        return [
            "version": 1,
            "fps": fps,
            "clock": clock,
            "slots": slots.map { Int($0) },
            "uptimesUs": uptimes.map { Int64(($0 * 1_000_000).rounded()) },
            "changed": changed.map { $0 ? 1 : 0 },
            "truncated": truncated,
        ]
    }
}
