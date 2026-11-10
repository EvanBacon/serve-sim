import Foundation

/// Monotonic count of captured frames whose IOSurface content changed.
///
/// Lives outside the `FrameCapture` actor behind a lock so the AX settle
/// detector can poll it every 20-50 ms without hopping onto the actor (busy
/// capturing and encoding during exactly the transitions being waited on) or
/// building the doctor diagnostics payload.
public final class ContentChangeCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count: UInt64 = 0

    public init() {}

    public func increment() {
        lock.lock()
        count &+= 1
        lock.unlock()
    }

    /// The count as a JS-safe integer (wraps far beyond any real session).
    public var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return Int(truncatingIfNeeded: count & 0x1F_FFFF_FFFF_FFFF)
    }
}
