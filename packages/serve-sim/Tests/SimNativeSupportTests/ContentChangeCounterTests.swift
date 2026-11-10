import XCTest
@testable import SimNativeSupport

final class ContentChangeCounterTests: XCTestCase {
    func testStartsAtZeroAndCountsIncrements() {
        let counter = ContentChangeCounter()
        XCTAssertEqual(counter.value, 0)
        counter.increment()
        counter.increment()
        XCTAssertEqual(counter.value, 2)
    }

    func testConcurrentIncrementsAreNotLost() {
        let counter = ContentChangeCounter()
        DispatchQueue.concurrentPerform(iterations: 1000) { _ in counter.increment() }
        XCTAssertEqual(counter.value, 1000)
    }
}
