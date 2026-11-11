import XCTest
@testable import SimNativeSupport

final class HIDDeliveryGateTests: XCTestCase {
    // SimDeviceState raw values from CoreSimulator.
    private let shutdown = 1, booting = 2, booted = 3, shuttingDown = 4

    func testDeliversWhileBooted() {
        let gate = HIDDeliveryGate { 3 }
        XCTAssertEqual(gate.admit(), .deliver(reconnect: false))
        XCTAssertEqual(gate.admit(), .deliver(reconnect: false))
    }

    func testDeliversWhenStateIsUnreadable() {
        // A CoreSimulator without a readable `state` keeps the old behaviour.
        let gate = HIDDeliveryGate { nil }
        XCTAssertEqual(gate.admit(), .deliver(reconnect: false))
    }

    func testDropsOnceTheDeviceStartsShuttingDown() {
        // `simctl shutdown` flips SimDevice.state to Shutting Down within
        // ~100ms, while SimDeviceLegacyHIDClient keeps accepting sends.
        var state = booted
        let gate = HIDDeliveryGate { state }
        XCTAssertEqual(gate.admit(), .deliver(reconnect: false))
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
        XCTAssertEqual(gate.admit(), .deliver(reconnect: true))
        state = shutdown
        guard case .drop(let log) = gate.admit() else { return XCTFail("expected drop") }
        XCTAssertNotNil(log)
    }

    func testBootingAndUnknownStatesAreNotBooted() {
        let booting = self.booting
        XCTAssertNotEqual(HIDDeliveryGate { booting }.admit(), .deliver(reconnect: false))
        guard case .drop(let log) = HIDDeliveryGate(readState: { 99 }).admit() else { return XCTFail("expected drop") }
        XCTAssertEqual(log, "[hid] Dropping input: simulator is state 99, not Booted")
    }

    // MARK: - Reconnect after the device comes back

    func testReturnToBootedAfterADropAsksForOneReconnect() {
        // The cached SimDeviceLegacyHIDClient's port died with the old boot;
        // it keeps failing with HIDError 3 even once the device reads Booted.
        var state = booted
        let gate = HIDDeliveryGate { state }
        XCTAssertEqual(gate.admit(), .deliver(reconnect: false))
        state = shuttingDown
        _ = gate.admit()
        state = shutdown
        _ = gate.admit()
        state = booting
        _ = gate.admit()
        state = booted
        XCTAssertEqual(gate.admit(), .deliver(reconnect: true))
        XCTAssertEqual(gate.admit(), .deliver(reconnect: false))
    }

    func testStateNotificationWithoutAnyInputStillAsksForReconnect() {
        // Shutdown + boot with no input in between: admit() only ever sees
        // Booted, so the device_state notification is the signal.
        let gate = HIDDeliveryGate { 3 }
        XCTAssertEqual(gate.admit(), .deliver(reconnect: false))
        gate.noteNotification(["notification": "device_state", "new_state": NSNumber(value: shuttingDown), "prev_state": NSNumber(value: booted)])
        gate.noteNotification(["notification": "device_state", "new_state": NSNumber(value: booted), "prev_state": NSNumber(value: booting)])
        XCTAssertEqual(gate.admit(), .deliver(reconnect: true))
        XCTAssertEqual(gate.admit(), .deliver(reconnect: false))
    }

    func testUnrelatedNotificationsDoNotReconnect() {
        let gate = HIDDeliveryGate { 3 }
        gate.noteNotification(["notification": "availableDevices_changed"])
        gate.noteNotification(["notification": "device_state", "new_state": NSNumber(value: booted)])
        gate.noteNotification(["notification": "SimDeviceNotificationType_BootStatus", "new_state": NSNumber(value: shutdown)])
        XCTAssertEqual(gate.admit(), .deliver(reconnect: false))
    }

    func testClientDisconnectAsksForReconnectEvenWithUnreadableState() {
        let gate = HIDDeliveryGate { nil }
        gate.noteClientDisconnected()
        XCTAssertEqual(gate.admit(), .deliver(reconnect: true))
        XCTAssertEqual(gate.admit(), .deliver(reconnect: false))
    }

    func testReconnectIsHeldUntilTheDeviceIsBooted() {
        var state = shutdown
        let gate = HIDDeliveryGate { state }
        gate.noteClientDisconnected()
        guard case .drop = gate.admit() else { return XCTFail("expected drop") }
        state = booted
        XCTAssertEqual(gate.admit(), .deliver(reconnect: true))
    }

    func testOnlyHIDError3CountsAsDisconnected() {
        let domain = "SimulatorKit.SimDeviceLegacyHIDClient.HIDError"
        XCTAssertTrue(HIDDeliveryGate.isClientDisconnected(domain: domain, code: 3))
        // HIDError 2 shows up for a fresh client while the guest is still
        // finishing boot; the same client works seconds later.
        XCTAssertFalse(HIDDeliveryGate.isClientDisconnected(domain: domain, code: 2))
        XCTAssertFalse(HIDDeliveryGate.isClientDisconnected(domain: NSPOSIXErrorDomain, code: 3))
    }
}
