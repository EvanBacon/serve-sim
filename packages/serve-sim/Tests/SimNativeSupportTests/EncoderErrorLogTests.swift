import XCTest
@testable import SimNativeSupport

final class EncoderErrorLogTests: XCTestCase {
    private let inner = EncoderErrorKey(
        codec: "AVCC",
        error: VideoToolboxStatus.describe(-12905),
        width: 2007,
        height: 2853
    )

    func testNamesPixelTransferStatus() {
        XCTAssertEqual(VideoToolboxStatus.describe(-12905), "kVTPixelTransferNotSupportedErr (-12905)")
        XCTAssertEqual(VideoToolboxStatus.describe(-1), "OSStatus -1")
    }

    func testFirstErrorPrintsOnceThenRepeatsAreCounted() {
        var log = EncoderErrorLog(summaryInterval: 10)
        XCTAssertEqual(log.record(inner, at: 0), [
            "[capture] AVCC encode failed at 2007x2853: kVTPixelTransferNotSupportedErr (-12905)",
        ])
        for i in 1...19 { XCTAssertEqual(log.record(inner, at: Double(i) * 0.1), []) }
        XCTAssertEqual(log.recovered(at: 2), [
            "[capture] AVCC encode failed at 2007x2853: kVTPixelTransferNotSupportedErr (-12905) repeated 19x in 2.0s; recovered",
        ])
        XCTAssertEqual(log.recovered(at: 3), [])
    }

    func testPeriodicSummaryAndKeyChange() {
        var log = EncoderErrorLog(summaryInterval: 10)
        _ = log.record(inner, at: 0)
        XCTAssertEqual(log.record(inner, at: 5), [])
        XCTAssertEqual(log.record(inner, at: 10).count, 1)
        let cover = EncoderErrorKey(codec: "AVCC", error: inner.error, width: 1398, height: 2034)
        XCTAssertEqual(log.record(cover, at: 11), [
            "[capture] AVCC encode failed at 1398x2034: kVTPixelTransferNotSupportedErr (-12905)",
        ])
    }

    func testSuccessOnOneCodecDoesNotResetAnotherCodecsSuppression() {
        var logs = CodecEncoderErrorLogs(summaryInterval: 10)
        XCTAssertEqual(logs.record(inner, at: 0).count, 1)
        // MJPEG keeps encoding fine while AVCC fails every frame.
        XCTAssertEqual(logs.recovered(codec: "MJPEG", at: 0.05), [])
        XCTAssertEqual(logs.record(inner, at: 0.1), [])
        XCTAssertEqual(logs.recovered(codec: "MJPEG", at: 0.15), [])
        XCTAssertEqual(logs.record(inner, at: 0.2), [])
        XCTAssertTrue(logs.isFailing(codec: "AVCC"))
        XCTAssertFalse(logs.isFailing(codec: "MJPEG"))
        XCTAssertEqual(logs.recovered(codec: "AVCC", at: 1), [
            "[capture] AVCC encode failed at 2007x2853: kVTPixelTransferNotSupportedErr (-12905) repeated 2x in 1.0s; recovered",
        ])
        XCTAssertFalse(logs.isFailing(codec: "AVCC"))
    }
}
