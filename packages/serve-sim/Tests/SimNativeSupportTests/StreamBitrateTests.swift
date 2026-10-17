import XCTest
@testable import SimNativeSupport

final class StreamBitrateTests: XCTestCase {
    func testIPhoneProScreenGetsEnoughBitsForFullScreenMotion() {
        // 1206x2622 @ 60fps: 6 Mbps starved heavy motion down to ~15 fps with
        // 700+ ms p95 latency; ~19 Mbps sustained 54+ fps in the benchmark.
        XCTAssertEqual(StreamBitrate.average(width: 1206, height: 2622, fps: 60), 18_972_792)
    }

    func testSmallScreensKeepTheFloor() {
        XCTAssertEqual(StreamBitrate.average(width: 396, height: 484, fps: 60), StreamBitrate.minimum)
    }

    func testLargeScreensAreCapped() {
        XCTAssertEqual(StreamBitrate.average(width: 2752, height: 2064, fps: 60), StreamBitrate.maximum)
    }

    func testDegenerateSizesFallBackToTheFloor() {
        XCTAssertEqual(StreamBitrate.average(width: 0, height: 0, fps: 60), StreamBitrate.minimum)
    }

    func testCapClampsTheScaledBitrate() {
        XCTAssertEqual(StreamBitrate.average(width: 1206, height: 2622, fps: 60, cap: 8_000_000), 8_000_000)
    }

    func testCapMayGoBelowTheFloor() {
        XCTAssertEqual(StreamBitrate.average(width: 396, height: 484, fps: 60, cap: 2_000_000), 2_000_000)
    }

    func testCapAboveTheScaledBitrateChangesNothing() {
        XCTAssertEqual(StreamBitrate.average(width: 1206, height: 2622, fps: 60, cap: 50_000_000), 18_972_792)
    }

    func testNonPositiveCapIsIgnored() {
        XCTAssertEqual(StreamBitrate.average(width: 1206, height: 2622, fps: 60, cap: 0), 18_972_792)
        XCTAssertEqual(StreamBitrate.average(width: 1206, height: 2622, fps: 60, cap: nil), 18_972_792)
    }
}
