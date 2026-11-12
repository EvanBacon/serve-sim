import Foundation

/// Decides whether an HID event may be handed to the guest, and when the HID
/// client has to be rebuilt first, based on the target `SimDevice`'s state.
///
/// `SimDeviceLegacyHIDClient` keeps accepting fire-and-forget sends after
/// `simctl shutdown` (its completion only reports "Mach port invalid, device
/// disconnected"), so without this check `serve-sim tap/button/gesture` acked
/// success until the detached server's shutdown watcher exited 5–15s later.
///
/// `SimDevice.state` usually leaves Booted within ~100ms of shutdown starting
/// and is a cheap in-process read. On some hosts, though, the same read blocks
/// for several seconds because `simctl shutdown` holds a CoreSimulator lock
/// (6.3s for the first post-shutdown `tap` on a macos-26 CI runner). When a
/// timeout is set, `admit` uses `BoundedStateReader` so that stall becomes a
/// drop instead of a hung ack. Notifications still catch a shutdown + boot
/// with no input in between.
///
/// The client also never recovers: once the device has left Booted, every
/// later send fails with HIDError 3, even after the same device boots again.
/// So any trip out of Booted (seen by `admit`, a `device_state` notification,
/// or a disconnect error from the client) makes the next delivery ask for a
/// reconnect. Not thread-safe: use it from one serial queue.
public final class HIDDeliveryGate {
    public enum Decision: Equatable {
        /// `reconnect` is true for the first delivery after the device (or
        /// the client) went away: rebuild the HID client before sending.
        case deliver(reconnect: Bool)
        /// `log` is set only for the first drop in a given state, so a drag
        /// against a dead device doesn't flood the server log.
        case drop(log: String?)
    }

    /// CoreSimulator's `SimDeviceState` raw value for a booted device.
    public static let bootedState = 3

    /// How long `admit` will wait for `SimDevice.state` when constructed
    /// with a timeout. Kept short so a stuck read cannot miss the 2s e2e bound.
    public static let stateReadTimeout: TimeInterval = BoundedStateReader.defaultTimeout

    private let readState: () -> Int?
    private let reader: BoundedStateReader?
    private var lastLoggedState: Int?
    private var loggedTimeout = false
    private var needsReconnect = false

    /// `readState` returns the raw `SimDeviceState`, or nil when it can't be
    /// read (then input is delivered as before). The probe runs synchronously
    /// on the caller's queue; tests use this form.
    public init(readState: @escaping () -> Int?) {
        self.readState = readState
        self.reader = nil
    }

    /// Like `init(readState:)`, but each `admit` runs the probe on a private
    /// queue and drops the input if it does not finish within `timeout`.
    public init(readState: @escaping () -> Int?, timeout: TimeInterval) {
        self.readState = readState
        self.reader = BoundedStateReader(timeout: timeout, read: readState)
    }

    public func admit() -> Decision {
        switch currentState() {
        case .timedOut:
            // A slow read on a still-Booted device is not a trip out of Booted.
            // Rebuilding the client (and resetting the Duo helper) on timeout
            // is reserved for a completed non-Booted read, a state
            // notification, or HIDError 3.
            if loggedTimeout { return .drop(log: nil) }
            loggedTimeout = true
            return .drop(log: "[hid] Dropping input: simulator state could not be read in time")
        case .ready(let state?):
            if state != Self.bootedState {
                needsReconnect = true
                loggedTimeout = false
                guard state != lastLoggedState else { return .drop(log: nil) }
                lastLoggedState = state
                return .drop(log: "[hid] Dropping input: simulator is \(Self.describe(state)), not Booted")
            }
            fallthrough
        case .ready(nil):
            lastLoggedState = nil
            loggedTimeout = false
            let reconnect = needsReconnect
            needsReconnect = false
            return .deliver(reconnect: reconnect)
        }
    }

    /// The HID client reported it can no longer reach the device.
    public func noteClientDisconnected() {
        needsReconnect = true
    }

    /// Feed a `-[SimDevice registerNotificationHandlerOnQueue:handler:]`
    /// payload. Catches a shutdown + boot that happens with no input in
    /// between, which `admit` alone would only ever see as Booted.
    public func noteNotification(_ info: [AnyHashable: Any]) {
        guard info["notification"] as? String == "device_state",
              let state = (info["new_state"] as? NSNumber)?.intValue,
              state != Self.bootedState else { return }
        needsReconnect = true
    }

    /// SimulatorKit's `SimDeviceLegacyHIDClient.HIDError` 3 ("Mach port
    /// invalid, device disconnected"). Error 2 is not a disconnect: a new
    /// client reports it while the guest is still finishing boot and then
    /// works. `HIDClientChannel` keeps a not-ready flag for error 2 and
    /// drops input until a send completes without error, or ~30s pass, so
    /// those sends are not acked as delivered.
    public static func isClientDisconnected(domain: String, code: Int) -> Bool {
        code == 3 && domain.hasSuffix("SimDeviceLegacyHIDClient.HIDError")
    }

    /// See `isClientDisconnected`. HIDError 2 while the guest is starting.
    public static func isClientNotReady(domain: String, code: Int) -> Bool {
        code == 2 && domain.hasSuffix("SimDeviceLegacyHIDClient.HIDError")
    }

    static func describe(_ state: Int) -> String {
        switch state {
        case 0: return "Creating (state 0)"
        case 1: return "Shutdown (state 1)"
        case 2: return "Booting (state 2)"
        case 4: return "Shutting Down (state 4)"
        default: return "state \(state)"
        }
    }

    private func currentState() -> BoundedStateReader.Probe {
        if let reader { return reader.probe() }
        return .ready(readState())
    }
}
