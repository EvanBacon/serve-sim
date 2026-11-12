import XCTest
@testable import SimNativeSupport

/// HIDInjector routes every input through `HIDClientChannel`: raw Indigo sends
/// get the client only via `send`, and buttons that never reach the client
/// (Home's SpringBoard relaunch, Duo-helper keys) run inside `gated`.
final class HIDClientChannelTests: XCTestCase {
    private final class FakeClient {}
    private let shutdown = 1, booting = 2, booted = 3, shuttingDown = 4

    private final class Harness {
        var state: Int? = 3
        var stateReads = 0
        var connects = 0
        var connectSucceeds = true
        var logs: [String] = []
        var reconnectHooks = 0
        var now: TimeInterval = 0
        lazy var channel: HIDClientChannel<FakeClient> = {
            let gate = HIDDeliveryGate { [unowned self] in
                self.stateReads += 1
                return self.state
            }
            return HIDClientChannel(
                gate: gate,
                connect: { [unowned self] in
                    self.connects += 1
                    return self.connectSucceeds ? FakeClient() : nil
                },
                log: { [unowned self] in self.logs.append($0) },
                didReconnect: { [unowned self] in self.reconnectHooks += 1 },
                now: { [unowned self] in self.now },
                notReadyLimit: 30,
                notReadyProbeInterval: 0.5
            )
        }()

        init() {}
        /// Mirrors HIDInjector.setup: the first client is created up front.
        func setup() { XCTAssertTrue(channel.connect()) }
    }

    func testStateIsReadOnEverySend() {
        let h = Harness(); h.setup()
        var sends = 0
        XCTAssertTrue(h.channel.send { _ in sends += 1; return true })
        XCTAssertTrue(h.channel.send { _ in sends += 1; return true })
        XCTAssertEqual(h.stateReads, 2)
        h.state = shuttingDown
        XCTAssertFalse(h.channel.send { _ in sends += 1; return true })
        XCTAssertEqual(h.stateReads, 3)
        XCTAssertEqual(sends, 2)
    }

    func testSendNeverReachesTheClientOnceTheDeviceLeavesBooted() {
        let h = Harness(); h.setup()
        var sends = 0
        h.state = shutdown
        for _ in 0..<5 { XCTAssertFalse(h.channel.send { _ in sends += 1; return true }) }
        XCTAssertEqual(sends, 0)
        XCTAssertEqual(h.logs, ["[hid] Dropping input: simulator is Shutdown (state 1), not Booted"])
    }

    func testGatedButtonsDoNotRunWhileShutDown() async {
        // Home relaunches SpringBoard and Duo buttons talk to the guest helper;
        // neither goes through `send`, so `gated` is their only check.
        let h = Harness(); h.setup()
        var homeLaunches = 0
        var ok = await h.channel.gated { homeLaunches += 1; return true }
        XCTAssertTrue(ok)
        h.state = shutdown
        ok = await h.channel.gated { homeLaunches += 1; return true }
        XCTAssertFalse(ok)
        XCTAssertEqual(homeLaunches, 1)
    }

    func testReturnToBootedReconnectsOnceBeforeTheNextSend() {
        let h = Harness(); h.setup()
        let first = h.channel.client
        h.state = shutdown
        XCTAssertFalse(h.channel.send { _ in true })
        h.state = booted
        var sentTo: [ObjectIdentifier] = []
        for _ in 0..<3 { XCTAssertTrue(h.channel.send { sentTo.append(ObjectIdentifier($0)); return true }) }
        XCTAssertEqual(h.connects, 2) // setup + exactly one reconnect
        XCTAssertEqual(h.reconnectHooks, 1)
        XCTAssertFalse(h.channel.client === first)
        XCTAssertEqual(Set(sentTo), [ObjectIdentifier(h.channel.client!)])
        XCTAssertEqual(h.logs.filter { $0 == "[hid] Simulator Booted again, reconnected HID client" }.count, 1)
    }

    func testRebootWithNoInputInBetweenReconnectsFromTheStateNotification() {
        let h = Harness(); h.setup()
        h.channel.noteDeviceNotification(["notification": "device_state", "new_state": NSNumber(value: shuttingDown)])
        h.channel.noteDeviceNotification(["notification": "device_state", "new_state": NSNumber(value: booted)])
        XCTAssertTrue(h.channel.send { _ in true })
        XCTAssertEqual(h.connects, 2)
    }

    func testGatedButtonAfterRebootAlsoReconnects() async {
        let h = Harness(); h.setup()
        h.state = shutdown
        _ = await h.channel.gated { true }
        h.state = booted
        let ok = await h.channel.gated { true }
        XCTAssertTrue(ok)
        XCTAssertEqual(h.connects, 2)
    }

    func testDisconnectErrorFromTheCurrentClientRebuildsOnTheNextSend() {
        let h = Harness(); h.setup()
        let first = h.channel.client!
        h.channel.clientReported(first, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 3)
        XCTAssertTrue(h.channel.send { _ in true })
        XCTAssertEqual(h.connects, 2)
        XCTAssertFalse(h.channel.client === first)
    }

    func testLateErrorsFromAReplacedClientAreIgnored() {
        let h = Harness(); h.setup()
        let first = h.channel.client!
        h.channel.clientReported(first, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 3)
        XCTAssertTrue(h.channel.send { _ in true }) // rebuilt
        // Completions for sends queued on the old client arrive afterwards.
        h.channel.clientReported(first, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 3)
        XCTAssertTrue(h.channel.send { _ in true })
        XCTAssertEqual(h.connects, 2)
    }

    func testBootErrorsDoNotRebuild() {
        let h = Harness(); h.setup()
        h.channel.clientReported(h.channel.client!, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 2)
        // Still the same client: error 2 means "not ready", not "disconnected".
        // The caller's event is not sent; a non-action probe is.
        var sends = 0
        var probes = 0
        XCTAssertFalse(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(sends, 0)
        XCTAssertEqual(probes, 1)
        XCTAssertEqual(h.connects, 1)
    }

    func testHIDError2DropsUntilASuccessfulProbe() {
        let h = Harness(); h.setup()
        let client = h.channel.client!
        h.channel.clientReported(client, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 2)
        var sends = 0
        var probes = 0
        // First send fires a non-action probe and returns false. A second
        // send in the same interval does not probe again. A success from
        // the probe re-enables delivery of the caller's event.
        XCTAssertFalse(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        XCTAssertFalse(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(sends, 0)
        XCTAssertEqual(probes, 1)
        XCTAssertEqual(h.logs, [HIDClientChannel<FakeClient>.notReadyMessage])
        h.channel.clientReportedSuccess(client)
        XCTAssertTrue(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(sends, 1)
        XCTAssertEqual(probes, 1)
        XCTAssertEqual(h.connects, 1)
    }

    func testHIDError2ProbeRunsOncePerIntervalAndSuccessReenablesDelivery() {
        let h = Harness(); h.setup()
        let client = h.channel.client!
        h.channel.clientReported(client, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 2)
        var sends = 0
        var probes = 0
        XCTAssertFalse(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        h.now = 0.4
        XCTAssertFalse(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(sends, 0)
        XCTAssertEqual(probes, 1)
        h.now = 0.5
        XCTAssertFalse(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(sends, 0)
        XCTAssertEqual(probes, 2)
        // Probe completion succeeds: later input is acked.
        h.channel.clientReportedSuccess(client)
        XCTAssertTrue(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(sends, 1)
        XCTAssertEqual(probes, 2)
        XCTAssertEqual(h.connects, 1)
    }

    func testHIDError2ProbeDoesNotTransmitTheCallerEvent() {
        // A tap is begin + end. If the begin were sent as an unacked probe,
        // the CLI would close on ok:false and never send the end, leaving
        // a finger down. The caller's events must stay unsent until a
        // non-action probe succeeds.
        let h = Harness(); h.setup()
        let client = h.channel.client!
        h.channel.clientReported(client, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 2)
        var events: [String] = []
        var probes = 0
        XCTAssertFalse(h.channel.send({ _ in events.append("begin"); return true }, probe: { _ in probes += 1; return true }))
        XCTAssertFalse(h.channel.send({ _ in events.append("end"); return true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(events, [])
        XCTAssertEqual(probes, 1)
        h.channel.clientReportedSuccess(client)
        XCTAssertTrue(h.channel.send({ _ in events.append("begin"); return true }, probe: { _ in probes += 1; return true }))
        XCTAssertTrue(h.channel.send({ _ in events.append("end"); return true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(events, ["begin", "end"])
        XCTAssertEqual(probes, 1)
    }

    func testFailedProbeDoesNotConsumeTheProbeSlot() {
        let h = Harness(); h.setup()
        h.channel.clientReported(h.channel.client!, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 2)
        var probes = 0
        XCTAssertFalse(h.channel.send({ _ in true }, probe: { _ in probes += 1; return false }))
        XCTAssertEqual(probes, 1)
        // Same instant: the failed probe must not start the interval.
        XCTAssertFalse(h.channel.send({ _ in true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(probes, 2)
    }

    func testGatedButtonsStillRunWhileHIDClientIsNotReady() async {
        // Home / Duo go through `gated`, not the HID client, so HIDError 2
        // must not refuse them (and a button-only flow must not wait 30s).
        let h = Harness(); h.setup()
        h.channel.clientReported(h.channel.client!, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 2)
        var homeLaunches = 0
        let ok = await h.channel.gated { homeLaunches += 1; return true }
        XCTAssertTrue(ok)
        XCTAssertEqual(homeLaunches, 1)
        var sends = 0
        XCTAssertFalse(h.channel.send { _ in sends += 1; return true })
        XCTAssertEqual(sends, 0)
    }

    func testHIDError2KeepsDroppingAfterTheLimitUntilASuccessfulProbe() {
        let h = Harness(); h.setup()
        let client = h.channel.client!
        h.channel.clientReported(client, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 2)
        var sends = 0
        var probes = 0
        h.now = 29
        XCTAssertFalse(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        h.now = 30
        XCTAssertFalse(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(sends, 0)
        XCTAssertEqual(probes, 2)
        XCTAssertTrue(h.logs.contains(HIDClientChannel<FakeClient>.notReadyMessage))
        XCTAssertTrue(h.logs.contains("[hid] HID client still not ready after 30s; continuing to probe, not acking input until a send succeeds"))
        h.channel.clientReportedSuccess(client)
        XCTAssertTrue(h.channel.send({ _ in sends += 1; return true }, probe: { _ in probes += 1; return true }))
        XCTAssertEqual(sends, 1)
        XCTAssertEqual(h.connects, 1)
    }

    func testLateSuccessFromAReplacedClientIsIgnored() {
        let h = Harness(); h.setup()
        let first = h.channel.client!
        h.channel.clientReported(first, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 3)
        XCTAssertTrue(h.channel.send { _ in true }) // rebuilt
        h.channel.clientReported(h.channel.client!, domain: "SimulatorKit.SimDeviceLegacyHIDClient.HIDError", code: 2)
        h.channel.clientReportedSuccess(first) // stale success must not clear not-ready
        XCTAssertFalse(h.channel.send { _ in true })
        XCTAssertEqual(h.connects, 2)
    }

    func testFailedReconnectReportsUndeliveredAndRetries() {
        let h = Harness(); h.setup()
        h.state = shutdown
        _ = h.channel.send { _ in true }
        h.state = booted
        h.connectSucceeds = false
        var sends = 0
        XCTAssertFalse(h.channel.send { _ in sends += 1; return true })
        XCTAssertEqual(sends, 0)
        h.connectSucceeds = true
        XCTAssertTrue(h.channel.send { _ in sends += 1; return true })
        XCTAssertEqual(sends, 1)
        XCTAssertEqual(h.connects, 3)
    }

    func testNoClientReportsUndelivered() {
        let h = Harness() // setup never connected
        var sends = 0
        XCTAssertFalse(h.channel.send { _ in sends += 1; return true })
        XCTAssertEqual(sends, 0)
    }

    func testTransmitFailureIsReported() {
        let h = Harness(); h.setup()
        XCTAssertFalse(h.channel.send { _ in false })
    }
}
