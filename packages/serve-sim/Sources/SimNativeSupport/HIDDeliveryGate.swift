import Foundation

/// Decides whether an HID event may be handed to the guest, based on the
/// target `SimDevice`'s state.
///
/// `SimDeviceLegacyHIDClient` keeps accepting fire-and-forget sends after
/// `simctl shutdown` (its completion only reports "Mach port invalid, device
/// disconnected"), so without this check `serve-sim tap/button/gesture` acked
/// success until the detached server's shutdown watcher exited 5–15s later.
/// `SimDevice.state` leaves Booted within ~100ms of the shutdown starting and
/// is a cheap in-process read, so gating on it adds no measurable latency.
public final class HIDDeliveryGate {
    public enum Decision: Equatable {
        case deliver
        /// `log` is set only for the first drop in a given state, so a drag
        /// against a dead device doesn't flood the server log.
        case drop(log: String?)
    }

    /// CoreSimulator's `SimDeviceState` raw value for a booted device.
    public static let bootedState = 3

    private let readState: () -> Int?
    private var lastLoggedState: Int?

    /// `readState` returns the raw `SimDeviceState`, or nil when it can't be
    /// read (then input is delivered as before).
    public init(readState: @escaping () -> Int?) {
        self.readState = readState
    }

    public func admit() -> Decision {
        guard let state = readState(), state != Self.bootedState else {
            lastLoggedState = nil
            return .deliver
        }
        guard state != lastLoggedState else { return .drop(log: nil) }
        lastLoggedState = state
        return .drop(log: "[hid] Dropping input: simulator is \(Self.describe(state)), not Booted")
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
