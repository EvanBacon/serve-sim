/// Identifies the pixels capture last emitted for a descriptor. IOSurface
/// seeds are per-surface counters, so when SimulatorKit swaps a descriptor's
/// surface the new one can carry the same seed as the old one; comparing the
/// seed alone would then skip the first frame of the new surface.
public struct SurfaceFrameStamp: Equatable, Sendable {
    public let surfaceID: UInt32
    public let seed: UInt32

    public init(surfaceID: UInt32, seed: UInt32) {
        self.surfaceID = surfaceID
        self.seed = seed
    }
}
