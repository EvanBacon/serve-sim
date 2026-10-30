import XCTest
@testable import SimNativeSupport

final class RecordingBitrateTests: XCTestCase {
    func testIPhoneProRecordingGetsMoreBitsThanTheLiveStream() {
        // 1206x2622 @ 60 fps: archival quality, ~2x the live stream's budget.
        let bitrate = RecordingBitrate.average(width: 1206, height: 2622, fps: 60)
        XCTAssertEqual(bitrate, 37_945_584)
        XCTAssertGreaterThan(bitrate, StreamBitrate.average(width: 1206, height: 2622, fps: 60))
    }

    func testSmallScreensKeepTheFloor() {
        XCTAssertEqual(RecordingBitrate.average(width: 396, height: 484, fps: 60), RecordingBitrate.minimum)
    }

    func testLargeScreensAreCapped() {
        XCTAssertEqual(RecordingBitrate.average(width: 3840, height: 2160, fps: 60), RecordingBitrate.maximum)
    }

    func testDegenerateSizesFallBackToTheFloor() {
        XCTAssertEqual(RecordingBitrate.average(width: 0, height: 0, fps: 60), RecordingBitrate.minimum)
    }
}
