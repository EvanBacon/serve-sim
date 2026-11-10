import CoreGraphics
import Foundation

/// How hard the AX bridge's hit-test grid looks for elements the tree walk
/// missed. Each grid probe is a ~1.1-1.5 ms XPC round trip that the app
/// answers serially (concurrent probes measured no faster), so probe count is
/// the whole cost of a describe: on an iOS 27 Settings list the walk takes
/// ~30-50 ms and the 32pt grid ~570 ms over ~340 probes.
///
/// - `exhaustive` is the `/ax` behaviour the web UI's overlay is built on:
///   anything at least 250pt in either dimension stays probe-able, so a wide
///   childless cell is hit-tested at every grid point it covers.
/// - `agent` (the `/ax/snapshot` path) lets wide childless controls (cells,
///   text fields) skip their probes as "soft" leaves, except where content
///   the walk can't see tends to sit on top of them: the top and bottom
///   screen bands (status bar, home indicator, floating bars, keyboard) and
///   rows next to anything the grid did discover there (see
///   `AccessibilityGridPlan`), and strides over background where probes
///   keep hitting elements already cataloged (`AccessibilityRowStride`).
///   On the iOS 27 screens checked (Settings root/General/Accessibility/a
///   toggles page/search, home screen, Contacts, Photos) it returns the same
///   normalized snapshot as `exhaustive` in 25-50% of the time.
public enum AccessibilityDiscoveryMode: Equatable, Sendable {
    case exhaustive
    case agent

    /// The JS-facing argument: `"agent"` selects agent discovery; anything
    /// else (including an older caller passing nothing) keeps `/ax` output.
    public init(argument: String?) {
        self = argument == "agent" ? .agent : .exhaustive
    }
}

/// How a serialized element affects later grid probes inside its frame.
public enum AccessibilityGridCover: Equatable, Sendable {
    /// Probes inside it are skipped.
    case leaf
    /// Probes inside it are skipped only in rows the plan doesn't force.
    case softLeaf
    /// Frame-dedup only; probes inside it still run.
    case container
}

public enum AccessibilityGridPolicy {
    /// At or above this size an element is too big to be one tappable thing.
    static let containerExtent: CGFloat = 250

    /// Roles (AX prefix stripped) that iOS uses for views which can hide
    /// their children from the walk but expose them to hit-testing.
    static let containerRoles: Set<String> = [
        "", "Application", "Window", "Group", "ScrollArea", "Table", "Collection",
        "Outline", "List", "WebArea", "LayoutArea", "SplitGroup", "TabGroup",
        "Toolbar", "GenericElement", "Unknown",
    ]

    public static func cover(
        role: String,
        frame: CGRect,
        hasChildren: Bool,
        mode: AccessibilityDiscoveryMode
    ) -> AccessibilityGridCover {
        if hasChildren { return .container }
        if max(frame.width, frame.height) < containerExtent { return .leaf }
        guard mode == .agent,
              min(frame.width, frame.height) < containerExtent,
              !containerRoles.contains(role) else { return .container }
        return .softLeaf
    }
}

/// Which grid rows must ignore soft leaves. Rows in the top/bottom bands are
/// always forced; `force(aroundDiscoveriesIn:)` widens that to the rows
/// next to any row where the grid found something, so a keyboard or a
/// floating bar is followed upward from the bottom band, row by row.
public struct AccessibilityGridPlan {
    /// Status bar and nav bar chrome; remote content lives here.
    public static let topBand: CGFloat = 60
    /// Home indicator, tab bars, floating search/accessory bars.
    public static let bottomBand: CGFloat = 110

    public let rows: [CGFloat]
    public let columns: [CGFloat]
    public private(set) var forced: Set<Int>

    public init(bounds: CGRect, step: CGFloat) {
        var rows: [CGFloat] = []
        var y = bounds.minY + step / 2
        while y < bounds.maxY { rows.append(y); y += step }
        var columns: [CGFloat] = []
        var x = bounds.minX + step / 2
        while x < bounds.maxX { columns.append(x); x += step }
        self.rows = rows
        self.columns = columns
        forced = Set(rows.indices.filter { rows[$0] < bounds.minY + Self.topBand || rows[$0] >= bounds.maxY - Self.bottomBand })
    }

    public func isForced(row: Int) -> Bool { forced.contains(row) }

    /// Force the unforced neighbours of `rows`; returns them (ascending) so
    /// the caller can re-probe just the points soft leaves let it skip.
    public mutating func force(aroundDiscoveriesIn discoveries: Set<Int>) -> [Int] {
        var added: [Int] = []
        for row in discoveries {
            for neighbour in [row - 1, row + 1] where self.rows.indices.contains(neighbour) {
                if forced.insert(neighbour).inserted { added.append(neighbour) }
            }
        }
        return added.sorted()
    }
}

/// Tracks which screen rects we've already cataloged so the grid walk
/// can skip points covered by existing elements (avoiding redundant XPC
/// round-trips) and skip elements we've already serialized (avoiding
/// duplicate subtrees). Round to whole points — AX frames wobble a
/// fractional pixel between fetches and we don't care.
public struct AccessibilityCoverage {
    private var leafRects: [CGRect] = []
    private var softLeafRects: [CGRect] = []
    private var keys: Set<String> = []

    public init() {}

    public mutating func insert(_ rect: CGRect, as cover: AccessibilityGridCover) {
        switch cover {
        case .leaf: insertLeaf(rect)
        case .softLeaf:
            if keys.insert(Self.key(for: rect)).inserted { softLeafRects.append(rect) }
        case .container: insertContainer(rect)
        }
    }

    /// Add a known-leaf rect — point-in-rect checks will skip XPC for any
    /// grid point falling inside it.
    public mutating func insertLeaf(_ rect: CGRect) {
        let key = Self.key(for: rect)
        if keys.insert(key).inserted {
            leafRects.append(rect)
        }
    }

    /// Add a container rect for frame-dedup only. Containers don't block
    /// grid probes — empty-children Groups (Nav bar, Tab Bar) are how iOS
    /// hides "remote" content, so points inside them must still be sampled.
    public mutating func insertContainer(_ rect: CGRect) {
        keys.insert(Self.key(for: rect))
    }

    public func contains(_ rect: CGRect) -> Bool {
        keys.contains(Self.key(for: rect))
    }

    public func contains(_ point: CGPoint) -> Bool {
        leafRects.contains { $0.contains(point) }
    }

    /// Whether only a soft leaf (not a real leaf) covers `point`.
    public func softContains(_ point: CGPoint) -> Bool {
        softLeafRects.contains { $0.contains(point) }
    }

    private static func key(for rect: CGRect) -> String {
        "\(Int(rect.origin.x.rounded())),\(Int(rect.origin.y.rounded())),\(Int(rect.size.width.rounded())),\(Int(rect.size.height.rounded()))"
    }
}

/// Remembers which hit-test results one describe call has already handled.
///
/// Neighbouring grid points mostly hit the same element (a 370pt cell spans
/// ~12 points), and AXPTranslationObject equality is by remote element id.
/// The first sighting of an element either leaves its frame in the coverage
/// set (skipped as known, recorded as the screen, or serialized) or is
/// dropped because it has no platform element, so on a static screen a
/// repeat could only re-fetch that frame over XPC and `continue`. Skipping it
/// is output-identical and saves ~0.35 ms per repeat probe.
///
/// Agent mode only. Exhaustive (`/ax`) keeps re-reading the frame on every
/// repeat, so an element that moved mid-describe or whose first serialize
/// failed can still be picked up, and its output never depends on how
/// coarse AXPTranslationObject's `-isEqual:` is.
public struct AccessibilityProbeMemo {
    private let enabled: Bool
    private var seen = Set<NSObject>()

    public init(mode: AccessibilityDiscoveryMode) {
        enabled = mode == .agent
    }

    /// True the first time an equal object is passed in this call; always
    /// true in exhaustive mode.
    public mutating func firstSighting(_ object: NSObject) -> Bool {
        guard enabled else { return true }
        return seen.insert(object).inserted
    }
}

/// Grid discoveries in output order. Agent mode's re-probes find elements
/// out of scan order, so they are sorted by the grid index of the probe that
/// found each one. Exhaustive mode's single pass is already in scan order and
/// is returned untouched.
public func accessibilityDiscoveryOrder<T>(
    _ discovered: [(index: Int, element: T)],
    mode: AccessibilityDiscoveryMode
) -> [T] {
    guard mode == .agent else { return discovered.map(\.element) }
    return discovered.enumerated()
        .sorted { ($0.element.index, $0.offset) < ($1.element.index, $1.offset) }
        .map { $0.element.element }
}

public enum AccessibilityProbeOutcome: Equatable, Sendable {
    /// No element, or one with no platform element.
    case nothing
    /// An element this call already cataloged (often the background group).
    case known
    /// A new element, now serialized.
    case discovered
}

/// Agent-mode stride through background: each probe that lands on an
/// element already cataloged (the list's background group in section gaps
/// and empty headers, or a cell already walked) skips the next columns, one
/// more per consecutive known hit up to `maxSkip`. A row that discovers
/// anything re-probes every point it skipped and forces its neighbours (see
/// `AccessibilityGridPlan`), so what the stride saves on quiet rows it gives
/// back wherever the walk missed something. Exhaustive mode never skips.
public struct AccessibilityRowStride {
    public static let maxSkip = 3
    private let enabled: Bool
    private var run = 0
    private var pending = 0

    public init(mode: AccessibilityDiscoveryMode) {
        enabled = mode == .agent
    }

    /// Whether to skip the current column.
    public mutating func skipsNext() -> Bool {
        guard pending > 0 else { return false }
        pending -= 1
        return true
    }

    public mutating func record(_ outcome: AccessibilityProbeOutcome) {
        guard enabled, outcome == .known else {
            run = 0
            pending = 0
            return
        }
        run += 1
        pending = min(run, Self.maxSkip)
    }
}
