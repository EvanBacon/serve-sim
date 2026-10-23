import XCTest
@testable import SimNativeSupport

final class RecordingFrameSchedulerTests: XCTestCase {
    private let frame = 1.0 / 60.0

    func testFirstFrameStartsAtSlotZero() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        XCTAssertEqual(scheduler.place(captureTime: 100), .init(repeats: 0..<0, slot: 0))
    }

    func testSteadySixtyFpsMapsOneFramePerSlot() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        for i in 0..<120 {
            let placement = scheduler.place(captureTime: 5 + Double(i) * frame)
            XCTAssertEqual(placement, .init(repeats: Int64(i)..<Int64(i), slot: Int64(i)))
        }
        XCTAssertEqual(scheduler.slotCount, 120)
    }

    func testJitteredCaptureTimesStillLandOnConsecutiveSlots() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        let jitter = [0.0, 4.0, -3.0, 6.0, -5.0, 2.0, 7.0, -7.0]
        var slots: [Int64] = []
        for (i, ms) in jitter.enumerated() {
            let placement = scheduler.place(captureTime: Double(i) * frame + ms / 1000)
            XCTAssertEqual(placement?.repeats.isEmpty, true)
            slots.append(placement!.slot)
        }
        XCTAssertEqual(slots, Array(0..<Int64(jitter.count)))
    }

    func testStaticGapRepeatsThePreviousFrame() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 0)
        // Nothing new for 100 ms (6 frame intervals): slots 1...5 repeat frame 0.
        XCTAssertEqual(scheduler.place(captureTime: 0.1), .init(repeats: 1..<6, slot: 6))
    }

    func testFrameSlightlyEarlyForATakenSlotMovesToTheNextSlot() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 0)
        _ = scheduler.place(captureTime: frame)
        // Rounds to slot 1 again (captured at 1.4 frames), but 2 is within a frame.
        XCTAssertEqual(scheduler.place(captureTime: 1.4 * frame), .init(repeats: 2..<2, slot: 2))
    }

    func testBurstAfterAStallIsKeptOnTheFollowingSlots() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 0)
        // Compositor hiccup: nothing at slot 1, then three frames ~2 ms apart
        // around slot 2. All three are distinct content and must be kept.
        XCTAssertEqual(scheduler.place(captureTime: 2 * frame), .init(repeats: 1..<2, slot: 2))
        XCTAssertEqual(scheduler.place(captureTime: 2 * frame + 0.002), .init(repeats: 3..<3, slot: 3))
        XCTAssertEqual(scheduler.place(captureTime: 2 * frame + 0.004), .init(repeats: 4..<4, slot: 4))
        // Back on cadence: the next frame lands on its own slot again.
        XCTAssertEqual(scheduler.place(captureTime: 5 * frame), .init(repeats: 5..<5, slot: 5))
    }

    func testFasterThanGridSourceDropsInsteadOfDrifting() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        var placed = 0
        // 120 Hz source for two seconds.
        for i in 0..<240 {
            let time = Double(i) / 120
            guard let placement = scheduler.place(captureTime: time) else { continue }
            placed += 1
            // Never more than `maxLag` intervals behind the real capture time.
            XCTAssertLessThan(Double(placement.slot) - time * 60, RecordingFrameScheduler.defaultMaxLag)
        }
        // One frame per 60 Hz slot, plus the few extra the lag budget absorbs
        // before the scheduler starts dropping.
        XCTAssertEqual(Double(placed), 120 + RecordingFrameScheduler.defaultMaxLag, accuracy: 1)
    }

    func testFinishPadsUntilStopTime() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 10)
        _ = scheduler.place(captureTime: 10 + frame)
        let end = scheduler.finish(at: 10.5)
        XCTAssertEqual(end?.repeats, 2..<31)
        XCTAssertEqual(end?.endSlot, 31)
    }

    func testFinishRightAfterLastFrameAddsNoRepeats() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 0)
        _ = scheduler.place(captureTime: frame)
        let end = scheduler.finish(at: frame + 0.001)
        XCTAssertEqual(end?.repeats.isEmpty, true)
        XCTAssertEqual(end?.endSlot, 2)
    }

    func testFinishWithoutFramesIsNil() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        XCTAssertNil(scheduler.finish(at: 1))
    }
}
