import Foundation

/// Decides whether an HID event may be handed to the guest, and when the HID
/// client has to be rebuilt first, based on the target `SimDevice`'s state.
///
/// `SimDeviceLegacyHIDClient` keeps accepting fire-and-forget sends after
/// `simctl shutdown` (its completion only reports "Mach port invalid, device
/// disconnected"), so without this check `serve-sim tap/button/gesture` acked
/// success until the detached server's shutdown watcher exited 5–15s later.
/// `SimDevice.state` leaves Booted within ~100ms of the shutdown starting and
/// is a cheap in-process read, so gating on it adds no measurable latency.
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

    private let readState: () -> Int?
    private var lastLoggedState: Int?
    private var needsReconnect = false

    /// `readState` returns the raw `SimDeviceState`, or nil when it can't be
    /// read (then input is delivered as before).
    public init(readState: @escaping () -> Int?) {
        self.readState = readState
    }

    public func admit() -> Decision {
        if let state = readState(), state != Self.bootedState {
            needsReconnect = true
            guard state != lastLoggedState else { return .drop(log: nil) }
            lastLoggedState = state
            return .drop(log: "[hid] Dropping input: simulator is \(Self.describe(state)), not Booted")
        }
        lastLoggedState = nil
        let reconnect = needsReconnect
        needsReconnect = false
        return .deliver(reconnect: reconnect)
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
    /// invalid, device disconnected"). Error 2 is not included: a new client
    /// reports it while the guest is still finishing boot and then works.
    public static func isClientDisconnected(domain: String, code: Int) -> Bool {
        code == 3 && domain.hasSuffix("SimDeviceLegacyHIDClient.HIDError")
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
}
