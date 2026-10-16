import XCTest
@testable import SimNativeSupport

final class SeedRecheckScheduleTests: XCTestCase {
    func testBacksOffAcrossRoughlyOneFrame() {
        let delays = (0..<6).map { SeedRecheckSchedule.delayMs(afterAttempt: $0) }
        XCTAssertEqual(delays, [1, 1, 2, 4, 8, nil])
        // Cumulative coverage ~16 ms: one 60 Hz frame, after which the next
        // frame callback (or the idle floor) takes over.
        XCTAssertEqual(delays.compactMap { $0 }.reduce(0, +), 16)
    }
}
