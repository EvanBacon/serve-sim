import XCTest
@testable import SimNativeSupport

final class BoundedStateReaderTests: XCTestCase {
    func testInstantReadIsReady() {
        let reader = BoundedStateReader(timeout: 0.1) { 3 }
        XCTAssertEqual(reader.probe(), .ready(3))
        XCTAssertEqual(reader.probe(), .ready(3))
    }

    func testNilStateIsReadyNil() {
        let reader = BoundedStateReader { nil }
        XCTAssertEqual(reader.probe(), .ready(nil))
    }

    func testStuckReadTimesOutWithoutWaitingForTheValue() {
        let hold = NSCondition()
        var stuck = true
        let reader = BoundedStateReader(timeout: 0.05) {
            hold.lock()
            while stuck { hold.wait() }
            hold.unlock()
            return 4
        }

        let t0 = Date()
        XCTAssertEqual(reader.probe(), .timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 0.2)

        // A second probe of the same in-flight read returns immediately.
        let t1 = Date()
        XCTAssertEqual(reader.probe(), .timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(t1), 0.03)

        hold.lock()
        stuck = false
        hold.broadcast()
        hold.unlock()

        // Once the stuck read finishes, the next probe starts a fresh,
        // unblocked read and returns the value.
        let deadline = Date().addingTimeInterval(1)
        var last: BoundedStateReader.Probe?
        while Date() < deadline {
            last = reader.probe()
            if last == .ready(4) { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        XCTAssertEqual(last, .ready(4))
    }

    func testOverlappingProbesShareOneRead() {
        let started = DispatchSemaphore(value: 0)
        let hold = DispatchSemaphore(value: 0)
        var calls = 0
        let reader = BoundedStateReader(timeout: 1) {
            calls += 1
            started.signal()
            hold.wait()
            return 1
        }

        let q = DispatchQueue.global(qos: .userInitiated)
        var first: BoundedStateReader.Probe?
        var second: BoundedStateReader.Probe?
        let firstDone = DispatchSemaphore(value: 0)
        let secondDone = DispatchSemaphore(value: 0)
        q.async {
            first = reader.probe()
            firstDone.signal()
        }
        started.wait()
        q.async {
            second = reader.probe()
            secondDone.signal()
        }
        // Wait until the second caller has entered probe() and joined the
        // in-flight read, then release it. A fixed sleep can miss that join.
        let joined = Date().addingTimeInterval(1)
        while reader.waiterCount < 2 && Date() < joined {
            Thread.sleep(forTimeInterval: 0.001)
        }
        XCTAssertGreaterThanOrEqual(reader.waiterCount, 2)
        hold.signal()
        firstDone.wait()
        secondDone.wait()
        XCTAssertEqual(first, .ready(1))
        XCTAssertEqual(second, .ready(1))
        XCTAssertEqual(calls, 1)
    }
}
