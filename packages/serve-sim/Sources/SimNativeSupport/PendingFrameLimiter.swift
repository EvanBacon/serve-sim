import Foundation

/// Thread-safe cap on frames queued for a slow consumer (the screen
/// recorder's writer queue). Each queued frame pins a full-resolution pixel
/// buffer, so when the encoder falls behind we drop new frames rather than
/// let the backlog grow without bound.
public final class PendingFrameLimiter: @unchecked Sendable {
    public let limit: Int
    private let lock = NSLock()
    private var _pending = 0
    private var _dropped = 0

    public init(limit: Int) {
        self.limit = max(1, limit)
    }

    /// Reserve a slot for one frame; false (and counted as dropped) when full.
    public func tryAcquire() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard _pending < limit else {
            _dropped += 1
            return false
        }
        _pending += 1
        return true
    }

    /// Free the slot once the frame has been handled.
    public func release() {
        lock.lock()
        _pending = max(0, _pending - 1)
        lock.unlock()
    }

    public var pending: Int {
        lock.lock()
        defer { lock.unlock() }
        return _pending
    }

    public var dropped: Int {
        lock.lock()
        defer { lock.unlock() }
        return _dropped
    }
}
