import XCTest
@testable import SimNativeSupport

final class SeedRecheckScheduleTests: XCTestCase {
    func testBacksOffAcrossRoughlyTwoFrames() {
        let delays = (0..<7).map { SeedRecheckSchedule.delayMs(afterAttempt: $0) }
        XCTAssertEqual(delays, [1, 1, 2, 4, 8, 16, nil])
        // Cumulative coverage ~32 ms (two 60 Hz frames); after that the next
        // frame callback or the idle floor takes over.
        XCTAssertEqual(delays.compactMap { $0 }.reduce(0, +), 32)
    }
}
