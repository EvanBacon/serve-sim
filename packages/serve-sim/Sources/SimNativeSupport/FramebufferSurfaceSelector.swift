public struct FramebufferSurfaceSize: Equatable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    public var isLive: Bool { width > 0 && height > 0 }

    fileprivate func matches(_ other: FramebufferSurfaceSize) -> Bool {
        (width == other.width && height == other.height)
            || (width == other.height && height == other.width)
    }
}

public struct FramebufferSurfaceSelection: Equatable, Sendable {
    public let index: Int
    public let matchedExpectedSize: Bool

    public init(index: Int, matchedExpectedSize: Bool) {
        self.index = index
        self.matchedExpectedSize = matchedExpectedSize
    }
}

/// Selects the simulator's main display without relying on a maximum-size
/// heuristic. Newer Device Hub versions may publish an additional presentation
/// surface (for example 7680x4320 while resizing); the device type's native
/// screen size identifies the real display. When that private metadata is not
/// available, the historical largest-live-surface behavior is preserved.
public enum FramebufferSurfaceSelector {
    public static func select(
        from candidates: [FramebufferSurfaceSize],
        expectedSize: FramebufferSurfaceSize?
    ) -> FramebufferSurfaceSelection? {
        let live = candidates.indices.filter { candidates[$0].isLive }
        guard !live.isEmpty else { return nil }

        if let expectedSize, expectedSize.isLive,
           let exact = live.first(where: { candidates[$0].matches(expectedSize) }) {
            return FramebufferSurfaceSelection(index: exact, matchedExpectedSize: true)
        }

        let largest = live.max { lhs, rhs in
            area(of: candidates[lhs]) < area(of: candidates[rhs])
        }!
        return FramebufferSurfaceSelection(index: largest, matchedExpectedSize: false)
    }

    private static func area(of size: FramebufferSurfaceSize) -> Int64 {
        Int64(size.width) * Int64(size.height)
    }
}
