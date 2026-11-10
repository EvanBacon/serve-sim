import CoreGraphics
import XCTest
@testable import SimNativeSupport

final class AccessibilityCoverageTests: XCTestCase {
    func testLeafBlocksPointsInsideIt() {
        var coverage = AccessibilityCoverage()
        coverage.insertLeaf(CGRect(x: 10, y: 10, width: 20, height: 20))
        XCTAssertTrue(coverage.contains(CGPoint(x: 15, y: 15)))
        XCTAssertFalse(coverage.contains(CGPoint(x: 40, y: 15)))
    }

    func testContainerDedupesFramesButDoesNotBlockPoints() {
        var coverage = AccessibilityCoverage()
        coverage.insertContainer(CGRect(x: 0, y: 0, width: 402, height: 874))
        XCTAssertTrue(coverage.contains(CGRect(x: 0, y: 0, width: 402, height: 874)))
        XCTAssertFalse(coverage.contains(CGPoint(x: 100, y: 100)))
    }

    func testFrameDedupIgnoresSubPointWobble() {
        var coverage = AccessibilityCoverage()
        coverage.insertLeaf(CGRect(x: 16, y: 380.33, width: 370, height: 52))
        XCTAssertTrue(coverage.contains(CGRect(x: 16.2, y: 380.4, width: 370, height: 51.9)))
    }
}

final class AccessibilityGridPolicyTests: XCTestCase {
    let cell = CGRect(x: 16, y: 380, width: 370, height: 52)
    let navBar = CGRect(x: 0, y: 54, width: 402, height: 54)
    let small = CGRect(x: 340, y: 811, width: 17, height: 22)
    let fullScreen = CGRect(x: 0, y: 0, width: 402, height: 874)

    func cover(_ role: String, _ frame: CGRect, children: Bool = false, _ mode: AccessibilityDiscoveryMode) -> AccessibilityGridCover {
        AccessibilityGridPolicy.cover(role: role, frame: frame, hasChildren: children, mode: mode)
    }

    func testExhaustiveModeKeepsTheSizeHeuristic() {
        // The /ax behaviour: anything >= 250pt stays probe-able, so a wide
        // childless cell button never blocks the grid.
        XCTAssertEqual(cover("Button", cell, .exhaustive), .container)
        XCTAssertEqual(cover("Button", small, .exhaustive), .leaf)
        XCTAssertEqual(cover("Button", small, children: true, .exhaustive), .container)
    }

    func testAgentModeMakesWideChildlessControlsSoftLeaves() {
        XCTAssertEqual(cover("Button", cell, .agent), .softLeaf)
        XCTAssertEqual(cover("TextField", CGRect(x: 28, y: 808, width: 346, height: 28), .agent), .softLeaf)
        XCTAssertEqual(cover("Button", small, .agent), .leaf)
    }

    func testAgentModeKeepsLargeGroupsProbeable() {
        // Nav bars, tab bars and scroll views hide remote children from the
        // walk but expose them to hit-testing, so they must not block.
        XCTAssertEqual(cover("Group", navBar, .agent), .container)
        XCTAssertEqual(cover("ScrollArea", fullScreen, .agent), .container)
        XCTAssertEqual(cover("", navBar, .agent), .container)
    }

    func testAgentModeKeepsAnythingLargeInBothDimensionsProbeable() {
        XCTAssertEqual(cover("Image", fullScreen, .agent), .container)
        XCTAssertEqual(cover("Cell", CGRect(x: 0, y: 0, width: 300, height: 300), .agent), .container)
    }

    func testElementsWithWalkedChildrenNeverBlock() {
        XCTAssertEqual(cover("Button", cell, children: true, .agent), .container)
    }

    func testModeParsing() {
        XCTAssertEqual(AccessibilityDiscoveryMode(argument: nil), .exhaustive)
        XCTAssertEqual(AccessibilityDiscoveryMode(argument: ""), .exhaustive)
        XCTAssertEqual(AccessibilityDiscoveryMode(argument: "agent"), .agent)
        XCTAssertEqual(AccessibilityDiscoveryMode(argument: "bogus"), .exhaustive)
    }
}

final class AccessibilityCoverageSoftLeafTests: XCTestCase {
    func testSoftLeafDedupesAndIsReportedSeparately() {
        var coverage = AccessibilityCoverage()
        let cell = CGRect(x: 16, y: 380, width: 370, height: 52)
        coverage.insert(cell, as: .softLeaf)
        XCTAssertTrue(coverage.contains(cell))
        XCTAssertFalse(coverage.contains(CGPoint(x: 100, y: 400)))
        XCTAssertTrue(coverage.softContains(CGPoint(x: 100, y: 400)))
    }
}

final class AccessibilityGridPlanTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 402, height: 874)

    func testRowsAndColumnsMatchTheExhaustiveScan() {
        let plan = AccessibilityGridPlan(bounds: screen, step: 32)
        XCTAssertEqual(plan.columns.first, 16)
        XCTAssertEqual(plan.columns.count, 13) // 16...400
        XCTAssertEqual(plan.rows.first, 16)
        XCTAssertEqual(plan.rows.count, 27) // 16, 48, ... 848 (880 is past 874)
        XCTAssertEqual(plan.rows.last, 848)
    }

    func testTopAndBottomBandsAreForced() {
        let plan = AccessibilityGridPlan(bounds: screen, step: 32)
        let forced = plan.rows.indices.filter { plan.isForced(row: $0) }.map { plan.rows[$0] }
        // top band < 60pt: rows 16, 48; bottom band >= 764pt: rows 784, 816, 848
        XCTAssertEqual(forced, [16, 48, 784, 816, 848])
    }

    func testDiscoveriesForceTheirNeighbours() {
        var plan = AccessibilityGridPlan(bounds: screen, step: 32)
        let keyboardRow = plan.rows.firstIndex(of: 784)!
        XCTAssertEqual(plan.force(aroundDiscoveriesIn: [keyboardRow]), [keyboardRow - 1])
        XCTAssertTrue(plan.isForced(row: keyboardRow - 1))
        // Already forced: nothing new.
        XCTAssertEqual(plan.force(aroundDiscoveriesIn: [keyboardRow]), [])
        XCTAssertEqual(plan.force(aroundDiscoveriesIn: [0]), [])
        XCTAssertEqual(plan.force(aroundDiscoveriesIn: [plan.rows.count - 1]), [])
    }
}

final class AccessibilityProbeMemoTests: XCTestCase {
    func testFirstSightingIsNewAndRepeatsAreNot() {
        var memo = AccessibilityProbeMemo(mode: .agent)
        let a = NSString(string: "a")
        let aAgain = NSString(string: "a") // equal by -isEqual:/-hash, distinct object
        let b = NSString(string: "b")
        XCTAssertTrue(memo.firstSighting(a))
        XCTAssertFalse(memo.firstSighting(aAgain))
        XCTAssertTrue(memo.firstSighting(b))
    }

    func testExhaustiveModeNeverShortCircuitsRepeats() {
        var memo = AccessibilityProbeMemo(mode: .exhaustive)
        let a = NSString(string: "a")
        XCTAssertTrue(memo.firstSighting(a))
        XCTAssertTrue(memo.firstSighting(a))
        XCTAssertTrue(memo.firstSighting(NSString(string: "a")))
    }
}

final class AccessibilityDiscoveryOrderTests: XCTestCase {
    func testExhaustiveKeepsScanOrderUntouched() {
        // Indices are never out of order in a single exhaustive pass, but even
        // if they were, exhaustive output is returned exactly as scanned.
        let found = [(index: 5, element: "b"), (index: 2, element: "a"), (index: 9, element: "c")]
        XCTAssertEqual(accessibilityDiscoveryOrder(found, mode: .exhaustive), ["b", "a", "c"])
    }

    func testAgentSortsByGridIndexStably() {
        let found = [(index: 5, element: "b"), (index: 2, element: "a"), (index: 5, element: "b2"), (index: 9, element: "c")]
        XCTAssertEqual(accessibilityDiscoveryOrder(found, mode: .agent), ["a", "b", "b2", "c"])
    }
}

final class AccessibilityRowStrideTests: XCTestCase {
    func skips(_ stride: inout AccessibilityRowStride) -> Int {
        var n = 0
        while stride.skipsNext() { n += 1 }
        return n
    }

    func testAgentModeSkipsMoreColumnsPerConsecutiveKnownHit() {
        var stride = AccessibilityRowStride(mode: .agent)
        XCTAssertEqual(skips(&stride), 0)
        stride.record(.known)
        XCTAssertEqual(skips(&stride), 1)
        stride.record(.known)
        XCTAssertEqual(skips(&stride), 2)
        stride.record(.known)
        XCTAssertEqual(skips(&stride), 3)
        stride.record(.known)
        XCTAssertEqual(skips(&stride), AccessibilityRowStride.maxSkip)
    }

    func testAnythingButAKnownHitResetsTheStride() {
        var stride = AccessibilityRowStride(mode: .agent)
        stride.record(.known)
        stride.record(.known)
        stride.record(.discovered)
        XCTAssertEqual(skips(&stride), 0)
        stride.record(.known)
        XCTAssertEqual(skips(&stride), 1)
        stride.record(.nothing)
        XCTAssertEqual(skips(&stride), 0)
    }

    func testExhaustiveModeNeverSkips() {
        var exhaustive = AccessibilityRowStride(mode: .exhaustive)
        exhaustive.record(.known)
        exhaustive.record(.known)
        XCTAssertEqual(skips(&exhaustive), 0)
    }
}
