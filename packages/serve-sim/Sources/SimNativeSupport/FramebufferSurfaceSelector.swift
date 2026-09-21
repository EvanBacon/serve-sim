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
/// screen sizes identify the real display(s). Foldables expose more than one
/// native size (cover + inner). With no preferred size, capture follows Device
/// Hub's rest pose: the smaller cover panel. A preferred size pins one of them.
/// When that private metadata is not available, the historical largest-live
/// surface behavior is preserved.
public enum FramebufferSurfaceSelector {
    public static func select(
        from candidates: [FramebufferSurfaceSize],
        expectedSize: FramebufferSurfaceSize?
    ) -> FramebufferSurfaceSelection? {
        select(
            from: candidates,
            expectedSizes: expectedSize.map { [$0] } ?? [],
            preferredSize: nil
        )
    }

    public static func select(
        from candidates: [FramebufferSurfaceSize],
        expectedSizes: [FramebufferSurfaceSize],
        preferredSize: FramebufferSurfaceSize? = nil
    ) -> FramebufferSurfaceSelection? {
        let live = candidates.indices.filter { candidates[$0].isLive }
        guard !live.isEmpty else { return nil }

        if let preferredSize, preferredSize.isLive,
           let preferred = live.first(where: { candidates[$0].matches(preferredSize) }) {
            return FramebufferSurfaceSelection(index: preferred, matchedExpectedSize: true)
        }

        let expectedLive = live.filter { index in
            expectedSizes.contains { $0.isLive && candidates[index].matches($0) }
        }
        if let bestExpected = expectedLive.min(by: { area(of: candidates[$0]) < area(of: candidates[$1]) }) {
            return FramebufferSurfaceSelection(index: bestExpected, matchedExpectedSize: true)
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
