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

    // MARK: - Incremental static fill

    func testRepeatsDueBeforeTheFirstFrameIsEmpty() {
        let scheduler = RecordingFrameScheduler(fps: 60)
        XCTAssertTrue(scheduler.repeatsDue(at: 10).isEmpty)
    }

    func testRepeatsDueLeavesHeadroomBehindNow() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 0)
        // 10 intervals in: slots 1...8 are due; 9 and 10 stay open for a
        // frame captured just before now that hasn't been delivered yet.
        XCTAssertEqual(scheduler.repeatsDue(at: 10 * frame + 0.001), 1..<9)
        XCTAssertTrue(scheduler.repeatsDue(at: 2 * frame).isEmpty)
    }

    func testDidFillAdvancesOnlyThroughWrittenSlots() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 0)
        // The encoder took slots 1...3 before refusing more: 4... stay owed.
        scheduler.didFill(through: 3)
        XCTAssertEqual(scheduler.slotCount, 4)
        XCTAssertEqual(scheduler.repeatsDue(at: 10 * frame + 0.001), 4..<9)
        // Committing an older slot never moves the grid backwards.
        scheduler.didFill(through: 1)
        XCTAssertEqual(scheduler.slotCount, 4)
    }

    /// The regression: after a long static stretch, filling incrementally
    /// leaves the next real frame (and the motion burst behind it) with no
    /// repeats to write first, so nothing queues up behind fill work.
    func testIncrementalFillKeepsMotionAfterAStaticStretchOnItsOwnSlots() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 0)
        var filled: Int64 = 0
        // 5 s static; the fill timer ticks every frame interval.
        for tick in 1...300 {
            let due = scheduler.repeatsDue(at: Double(tick) * frame + 0.0005)
            filled += Int64(due.count)
            if let last = due.last { scheduler.didFill(through: last) }
        }
        XCTAssertEqual(filled, 298)
        // Motion resumes at 60 fps; each frame is delivered ~1 ms after capture.
        var slots: [Int64] = []
        for i in 0..<30 {
            let captured = 5.0 + Double(i) * frame
            let placement = scheduler.place(captureTime: captured)
            XCTAssertNotNil(placement, "frame \(i) dropped")
            XCTAssertLessThanOrEqual(placement?.repeats.count ?? 99, 1, "frame \(i) waits on a repeat backlog")
            slots.append(placement!.slot)
            let due = scheduler.repeatsDue(at: captured + 0.001)
            XCTAssertTrue(due.isEmpty, "fill raced ahead of motion at frame \(i)")
        }
        XCTAssertEqual(slots, Array(300..<330))
    }

    func testFrameDeliveredAfterAFillTickStillLandsOnItsSlot() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 0)
        // A tick at 1.0 s fills through slot 58 while a frame captured at
        // 0.99 s (slot 59) is still in flight; it must not be dropped.
        let due = scheduler.repeatsDue(at: 1.0)
        XCTAssertEqual(due.last, 58)
        scheduler.didFill(through: due.last!)
        XCTAssertEqual(scheduler.place(captureTime: 0.99), .init(repeats: 59..<59, slot: 59))
    }

    func testFinishAfterIncrementalFillPadsOnlyTheTail() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 0)
        scheduler.didFill(through: scheduler.repeatsDue(at: 1.0).last!)
        let end = scheduler.finish(at: 1.0)
        XCTAssertEqual(end?.repeats, 59..<61)
        XCTAssertEqual(end?.endSlot, 61)
    }

    /// Encoder backlog: the writer queue is ~300 ms behind, so a fill tick
    /// runs after "now" has passed frames still queued for the writer. It
    /// must leave their slots open rather than fill them with stale repeats.
    func testFillDefersToFramesQueuedBehindASlowEncoder() {
        var scheduler = RecordingFrameScheduler(fps: 60)
        _ = scheduler.place(captureTime: 0)
        // Frames captured at slots 1...18 are queued; the tick sees now = 0.3 s.
        XCTAssertTrue(scheduler.repeatsDue(at: 0.3, framesPending: 18).isEmpty)
        var slots: [Int64] = []
        for i in 1...18 {
            let placement = scheduler.place(captureTime: Double(i) * frame)
            XCTAssertNotNil(placement, "queued frame \(i) dropped")
            slots.append(placement!.slot)
        }
        XCTAssertEqual(slots, Array(1...18))
        // Backlog drained: the fill resumes behind the last real frame.
        XCTAssertEqual(scheduler.repeatsDue(at: 0.5 + 0.001, framesPending: 0), 19..<29)
    }
}
