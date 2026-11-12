import Foundation

/// Owns the HID client and is the only way input reaches it, so every send
/// is gated on the device's state and runs on a client from the current boot.
///
/// - `send` hands the client to raw Indigo sends.
/// - `gated` covers input that never touches the client (Home relaunches
///   SpringBoard; Duo buttons go through the guest helper).
///
/// Both check `HIDDeliveryGate` on every call. On the first call after the
/// device comes back to Booted they rebuild the client (once), call
/// `didReconnect`, and log it. Not thread-safe: use it from one serial queue
/// (HIDInjector's executor, which also receives the client's completions
/// and the device's notifications).
public final class HIDClientChannel<Client: AnyObject> {
    public static var reconnectedMessage: String { "[hid] Simulator Booted again, reconnected HID client" }
    public static var notReadyMessage: String { "[hid] Dropping input: HID client is not ready (HIDError 2, guest still starting)" }
    public static var notReadyLimit: TimeInterval { 30 }
    /// While not-ready, one non-action probe is allowed this often so a
    /// successful completion can clear the flag. The caller's event is never
    /// used as that probe.
    public static var notReadyProbeInterval: TimeInterval { 0.5 }

    private enum SendAdmission {
        case drop
        case deliver
        case probe
    }

    private let gate: HIDDeliveryGate
    private let makeClient: () -> Client?
    private let log: (String) -> Void
    private let didReconnect: () -> Void
    private let now: () -> TimeInterval
    private let notReadyLimit: TimeInterval
    private let notReadyProbeInterval: TimeInterval
    private var notReady = false
    private var notReadySince: TimeInterval?
    private var lastNotReadyProbeAt: TimeInterval?
    private var loggedNotReady = false
    private var loggedNotReadyLimit = false
    public private(set) var client: Client?

    public init(
        gate: HIDDeliveryGate,
        connect: @escaping () -> Client?,
        log: @escaping (String) -> Void,
        didReconnect: @escaping () -> Void = {},
        now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        notReadyLimit: TimeInterval = HIDClientChannel<Client>.notReadyLimit,
        notReadyProbeInterval: TimeInterval = HIDClientChannel<Client>.notReadyProbeInterval
    ) {
        self.gate = gate
        self.makeClient = connect
        self.log = log
        self.didReconnect = didReconnect
        self.now = now
        self.notReadyLimit = notReadyLimit
        self.notReadyProbeInterval = notReadyProbeInterval
    }

    /// Create (or replace) the client. Returns whether one exists now.
    @discardableResult
    public func connect() -> Bool {
        client = makeClient()
        clearNotReady()
        return client != nil
    }

    /// Use an already-created client (setup creates the first one itself so
    /// its error can fail setup).
    public func adopt(_ client: Client) {
        self.client = client
        clearNotReady()
    }

    /// Whether input that does not go through the HID client may run now
    /// (Home's SpringBoard relaunch, Duo-helper keys). Rebuilds the client
    /// first when the device has just come back. Does not apply the
    /// HIDError-2 not-ready window: that only affects Indigo sends.
    public func admit() -> Bool {
        switch gate.admit() {
        case .drop(let message):
            if let message { log(message) }
            return false
        case .deliver(reconnect: false):
            return true
        case .deliver(reconnect: true):
            guard connect() else {
                // Try again on the next input rather than sending through a dead port.
                gate.noteClientDisconnected()
                log("[hid] Simulator Booted again, but the HID client could not be recreated")
                return false
            }
            log(Self.reconnectedMessage)
            didReconnect()
            return true
        }
    }

    /// Gate, then hand the current client to `transmit`. False when the
    /// device isn't booted, there is no client, `transmit` failed, or the
    /// HID client is not ready. A successful return means the message was
    /// handed to the client (the existing ready-path contract); it is not a
    /// guest completion. While not-ready, `transmit` is not called — a
    /// non-action `probe` is sent at most once per `notReadyProbeInterval`
    /// instead, and this returns false so the caller's event is never
    /// acked or left half-delivered. `probe` isn't called when the device
    /// isn't booted or there is no client, and the probe slot is only
    /// consumed when `probe` returns true.
    public func send(_ transmit: (Client) -> Bool, probe: ((Client) -> Bool)? = nil) -> Bool {
        switch admitForSend() {
        case .drop:
            return false
        case .deliver:
            guard let client else {
                log("[hid] Dropped HID message: no SimDeviceLegacyHIDClient")
                return false
            }
            return transmit(client)
        case .probe:
            guard let client else {
                log("[hid] Dropped HID message: no SimDeviceLegacyHIDClient")
                return false
            }
            if probe?(client) == true {
                lastNotReadyProbeAt = now()
            }
            return false
        }
    }

    /// Gate input that doesn't go through the client (it still triggers the
    /// reconnect, so the next touch after a Home press works).
    public func gated(
        isolation: isolated (any Actor)? = #isolation,
        _ body: () async -> Bool
    ) async -> Bool {
        guard admit() else { return false }
        return await body()
    }

    /// A send completion from `reporter`. A disconnect error from the
    /// current client makes the next input rebuild it. A not-ready error
    /// (HIDError 2) drops later Indigo input until a probe or send
    /// completes without error. Time passing does not clear the flag.
    /// Late errors from a client that was already replaced are ignored.
    public func clientReported(_ reporter: Client, domain: String, code: Int) {
        guard reporter === client else { return }
        if HIDDeliveryGate.isClientDisconnected(domain: domain, code: code) {
            gate.noteClientDisconnected()
            clearNotReady()
            return
        }
        guard HIDDeliveryGate.isClientNotReady(domain: domain, code: code) else { return }
        if !notReady {
            notReady = true
            notReadySince = now()
            lastNotReadyProbeAt = nil
            loggedNotReady = false
            loggedNotReadyLimit = false
        }
    }

    /// A successful send completion from `reporter` clears the not-ready
    /// flag: the guest accepted input, so later sends can be acked again.
    public func clientReportedSuccess(_ reporter: Client) {
        guard reporter === client else { return }
        clearNotReady()
    }

    /// See `HIDDeliveryGate.noteNotification`.
    public func noteDeviceNotification(_ info: [AnyHashable: Any]) {
        gate.noteNotification(info)
    }

    /// Like `admit()`, but while not-ready withholds the caller's event and
    /// lets one non-action probe through every `notReadyProbeInterval`.
    private func admitForSend() -> SendAdmission {
        switch gate.admit() {
        case .drop(let message):
            if let message { log(message) }
            return .drop
        case .deliver(reconnect: false):
            return admitReadyForSend()
        case .deliver(reconnect: true):
            guard connect() else {
                gate.noteClientDisconnected()
                log("[hid] Simulator Booted again, but the HID client could not be recreated")
                return .drop
            }
            log(Self.reconnectedMessage)
            didReconnect()
            return admitReadyForSend()
        }
    }

    private func admitReadyForSend() -> SendAdmission {
        guard notReady else { return .deliver }
        logNotReadyOnce()
        logNotReadyLimitOnce()
        let t = now()
        if let last = lastNotReadyProbeAt, t - last < notReadyProbeInterval {
            return .drop
        }
        return .probe
    }

    private func logNotReadyOnce() {
        if !loggedNotReady {
            log(Self.notReadyMessage)
            loggedNotReady = true
        }
    }

    private func logNotReadyLimitOnce() {
        guard !loggedNotReadyLimit else { return }
        let started = notReadySince ?? now()
        guard now() - started >= notReadyLimit else { return }
        log("[hid] HID client still not ready after \(Int(notReadyLimit))s; continuing to probe, not acking input until a send succeeds")
        loggedNotReadyLimit = true
    }

    private func clearNotReady() {
        notReady = false
        notReadySince = nil
        lastNotReadyProbeAt = nil
        loggedNotReady = false
        loggedNotReadyLimit = false
    }
}
