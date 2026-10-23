import XCTest
@testable import SimNativeSupport

final class PendingFrameLimiterTests: XCTestCase {
    func testAdmitsUpToTheLimitThenDrops() {
        let limiter = PendingFrameLimiter(limit: 3)
        XCTAssertTrue(limiter.tryAcquire())
        XCTAssertTrue(limiter.tryAcquire())
        XCTAssertTrue(limiter.tryAcquire())
        XCTAssertFalse(limiter.tryAcquire())
        XCTAssertFalse(limiter.tryAcquire())
        XCTAssertEqual(limiter.pending, 3)
        XCTAssertEqual(limiter.dropped, 2)
    }

    func testReleaseFreesASlot() {
        let limiter = PendingFrameLimiter(limit: 1)
        XCTAssertTrue(limiter.tryAcquire())
        XCTAssertFalse(limiter.tryAcquire())
        limiter.release()
        XCTAssertEqual(limiter.pending, 0)
        XCTAssertTrue(limiter.tryAcquire())
        XCTAssertEqual(limiter.dropped, 1)
    }

    func testConcurrentProducersNeverExceedTheLimit() {
        let limiter = PendingFrameLimiter(limit: 12)
        DispatchQueue.concurrentPerform(iterations: 1_000) { _ in
            _ = limiter.tryAcquire()
        }
        XCTAssertEqual(limiter.pending, 12)
        XCTAssertEqual(limiter.dropped, 988)
    }
}
