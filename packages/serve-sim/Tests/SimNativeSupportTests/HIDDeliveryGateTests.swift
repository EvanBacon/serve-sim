import XCTest
@testable import SimNativeSupport

final class HIDDeliveryGateTests: XCTestCase {
    // SimDeviceState raw values from CoreSimulator.
    private let shutdown = 1, booting = 2, booted = 3, shuttingDown = 4

    func testDeliversWhileBooted() {
        let gate = HIDDeliveryGate { 3 }
        XCTAssertEqual(gate.admit(), .deliver)
        XCTAssertEqual(gate.admit(), .deliver)
    }

    func testDeliversWhenStateIsUnreadable() {
        // A CoreSimulator without a readable `state` keeps the old behaviour.
        let gate = HIDDeliveryGate { nil }
        XCTAssertEqual(gate.admit(), .deliver)
    }

    func testDropsOnceTheDeviceStartsShuttingDown() {
        // `simctl shutdown` flips SimDevice.state to Shutting Down within
        // ~100ms, while SimDeviceLegacyHIDClient keeps accepting sends.
        var state = booted
        let gate = HIDDeliveryGate { state }
        XCTAssertEqual(gate.admit(), .deliver)
        state = shuttingDown
        XCTAssertEqual(gate.admit(), .drop(log: "[hid] Dropping input: simulator is Shutting Down (state 4), not Booted"))
        state = shutdown
        XCTAssertEqual(gate.admit(), .drop(log: "[hid] Dropping input: simulator is Shutdown (state 1), not Booted"))
    }

    func testLogsOnlyTheFirstDropPerState() {
        let gate = HIDDeliveryGate { 1 }
        guard case .drop(let first) = gate.admit() else { return XCTFail("expected drop") }
        XCTAssertNotNil(first)
        XCTAssertEqual(gate.admit(), .drop(log: nil))
        XCTAssertEqual(gate.admit(), .drop(log: nil))
    }

    func testLogsAgainAfterTheDeviceRecovers() {
        var state = shutdown
        let gate = HIDDeliveryGate { state }
        _ = gate.admit()
        state = booted
        XCTAssertEqual(gate.admit(), .deliver)
        state = shutdown
        guard case .drop(let log) = gate.admit() else { return XCTFail("expected drop") }
        XCTAssertNotNil(log)
    }

    func testBootingAndUnknownStatesAreNotBooted() {
        let booting = self.booting
        XCTAssertNotEqual(HIDDeliveryGate { booting }.admit(), .deliver)
        guard case .drop(let log) = HIDDeliveryGate(readState: { 99 }).admit() else { return XCTFail("expected drop") }
        XCTAssertEqual(log, "[hid] Dropping input: simulator is state 99, not Booted")
    }
}
