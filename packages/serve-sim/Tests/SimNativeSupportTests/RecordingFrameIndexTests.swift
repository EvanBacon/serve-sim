import XCTest
@testable import SimNativeSupport

final class RecordingFrameIndexTests: XCTestCase {
    private func source(_ sequence: UInt64, at time: Double, seed: UInt32? = nil, surface: UInt32 = 7) -> RecordingFrameIndex.Source {
        RecordingFrameIndex.Source(
            sequence: sequence,
            captureTime: time,
            stamp: seed.map { SurfaceFrameStamp(surfaceID: surface, seed: $0) }
        )
    }

    func testFirstWriteIsChanged() {
        var index = RecordingFrameIndex()
        index.recordWrite(slot: 0, source: source(1, at: 10, seed: 1))
        XCTAssertEqual(index.count, 1)
        XCTAssertEqual(index.slots, [0])
        XCTAssertEqual(index.changed, [true])
        XCTAssertEqual(index.changedCount, 1)
    }

    func testRepeatSlotsOfTheSameSourceAreUnchanged() {
        var index = RecordingFrameIndex()
        let first = source(1, at: 10, seed: 1)
        index.recordWrite(slot: 0, source: first)
        // fillStaticSlots / placement repeats re-append the same buffer.
        index.recordWrite(slot: 1, source: first)
        index.recordWrite(slot: 2, source: first)
        XCTAssertEqual(index.changed, [true, false, false])
        XCTAssertEqual(index.changedCount, 1)
        // Repeats carry the capture time of the frame whose pixels they hold.
        XCTAssertEqual(index.uptimes, [10, 10, 10])
    }

    func testNewSourceWithANewSeedIsChanged() {
        var index = RecordingFrameIndex()
        index.recordWrite(slot: 0, source: source(1, at: 10, seed: 1))
        index.recordWrite(slot: 1, source: source(2, at: 10.016, seed: 2))
        XCTAssertEqual(index.changed, [true, true])
        XCTAssertEqual(index.uptimes, [10, 10.016])
    }

    func testIdleReEmitWithTheSameStampIsUnchanged() {
        // FrameCapture's idle tick force-emits the unchanged surface at ~5 fps;
        // that's a new captured frame but identical pixels.
        var index = RecordingFrameIndex()
        index.recordWrite(slot: 0, source: source(1, at: 10, seed: 5))
        index.recordWrite(slot: 12, source: source(2, at: 10.2, seed: 5))
        XCTAssertEqual(index.changed, [true, false])
        XCTAssertEqual(index.uptimes, [10, 10.2])
    }

    func testSameSeedOnASwappedSurfaceIsChanged() {
        var index = RecordingFrameIndex()
        index.recordWrite(slot: 0, source: source(1, at: 10, seed: 5, surface: 1))
        index.recordWrite(slot: 1, source: source(2, at: 10.016, seed: 5, surface: 2))
        XCTAssertEqual(index.changed, [true, true])
    }

    func testUnknownStampCountsAsChangedForANewSource() {
        var index = RecordingFrameIndex()
        index.recordWrite(slot: 0, source: source(1, at: 10))
        index.recordWrite(slot: 1, source: source(1, at: 10))
        index.recordWrite(slot: 2, source: source(2, at: 10.03))
        XCTAssertEqual(index.changed, [true, false, true])
    }

    func testChangeIsAgainstTheLastWrittenSlotNotTheLastCapturedFrame() {
        // Frame 2's own slot write failed (encoder busy) but it became the
        // repeat source; its first written repeat is the visible change.
        var index = RecordingFrameIndex()
        index.recordWrite(slot: 0, source: source(1, at: 10, seed: 1))
        let second = source(2, at: 10.016, seed: 2)
        index.recordWrite(slot: 2, source: second)
        index.recordWrite(slot: 3, source: second)
        XCTAssertEqual(index.slots, [0, 2, 3])
        XCTAssertEqual(index.changed, [true, true, false])
    }

    func testCapacityBoundsMemoryAndFlagsTruncation() {
        var index = RecordingFrameIndex(capacity: 3)
        let s = source(1, at: 1, seed: 1)
        for slot in 0..<5 { index.recordWrite(slot: Int64(slot), source: s) }
        XCTAssertEqual(index.count, 3)
        XCTAssertTrue(index.truncated)
        XCTAssertEqual(index.slots, [0, 1, 2])
    }

    func testDefaultCapacityCoversThirtyMinutesAtOneHundredTwentyFps() {
        XCTAssertGreaterThanOrEqual(RecordingFrameIndex.defaultCapacity, 30 * 60 * 120)
    }

    func testJsonObjectIsCompact() {
        var index = RecordingFrameIndex()
        let a = source(1, at: 100.000_001, seed: 1)
        index.recordWrite(slot: 0, source: a)
        index.recordWrite(slot: 1, source: a)
        index.recordWrite(slot: 2, source: source(2, at: 100.05, seed: 2))
        let object = index.jsonObject(fps: 60, originUptime: 100.000_001, armedUptime: 99.9, armedWallMs: 1_700_000_000_123.5)
        XCTAssertEqual(object["version"] as? Int, 1)
        XCTAssertEqual(object["fps"] as? Int, 60)
        XCTAssertEqual(object["slots"] as? [Int], [0, 1, 2])
        XCTAssertEqual(object["changed"] as? [Int], [1, 0, 1])
        // Microseconds since boot: exact integers, safe as JS numbers.
        XCTAssertEqual(object["uptimesUs"] as? [Int64], [100_000_001, 100_000_001, 100_050_000])
        XCTAssertEqual(object["truncated"] as? Bool, false)
        let clock = object["clock"] as? [String: Double]
        XCTAssertEqual(clock?["originUptime"], 100.000_001)
        XCTAssertEqual(clock?["armedUptime"], 99.9)
        XCTAssertEqual(clock?["armedWallMs"], 1_700_000_000_123.5)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(object))
    }

    func testJsonObjectOmitsOriginWhenNoFrameWasPlaced() {
        let object = RecordingFrameIndex().jsonObject(fps: 30, originUptime: nil, armedUptime: 1, armedWallMs: 2)
        let clock = object["clock"] as? [String: Double]
        XCTAssertNil(clock?["originUptime"])
        XCTAssertEqual(object["slots"] as? [Int], [])
    }
}
