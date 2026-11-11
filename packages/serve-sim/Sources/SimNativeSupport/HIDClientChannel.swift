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

    private let gate: HIDDeliveryGate
    private let makeClient: () -> Client?
    private let log: (String) -> Void
    private let didReconnect: () -> Void
    private let now: () -> TimeInterval
    private let notReadyLimit: TimeInterval
    private var notReady = false
    private var notReadySince: TimeInterval?
    private var loggedNotReady = false
    public private(set) var client: Client?

    public init(
        gate: HIDDeliveryGate,
        connect: @escaping () -> Client?,
        log: @escaping (String) -> Void,
        didReconnect: @escaping () -> Void = {},
        now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        notReadyLimit: TimeInterval = HIDClientChannel<Client>.notReadyLimit
    ) {
        self.gate = gate
        self.makeClient = connect
        self.log = log
        self.didReconnect = didReconnect
        self.now = now
        self.notReadyLimit = notReadyLimit
    }

    /// Create (or replace) the client. Returns whether one exists now.
    @discardableResult
    public func connect() -> Bool {
        client = makeClient()
        notReady = false
        notReadySince = nil
        loggedNotReady = false
        return client != nil
    }

    /// Use an already-created client (setup creates the first one itself so
    /// its error can fail setup).
    public func adopt(_ client: Client) {
        self.client = client
        notReady = false
        notReadySince = nil
        loggedNotReady = false
    }

    /// Whether input may go to the guest now. Rebuilds the client first when
    /// the device has just come back.
    public func admit() -> Bool {
        switch gate.admit() {
        case .drop(let message):
            if let message { log(message) }
            return false
        case .deliver(reconnect: false):
            return admitReady()
        case .deliver(reconnect: true):
            guard connect() else {
                // Try again on the next input rather than sending through a dead port.
                gate.noteClientDisconnected()
                log("[hid] Simulator Booted again, but the HID client could not be recreated")
                return false
            }
            log(Self.reconnectedMessage)
            didReconnect()
            return admitReady()
        }
    }

    /// Gate, then hand the current client to `transmit`. False when the
    /// device isn't booted, there is no client, or `transmit` failed;
    /// `transmit` isn't called in the first two cases.
    public func send(_ transmit: (Client) -> Bool) -> Bool {
        guard admit() else { return false }
        guard let client else {
            log("[hid] Dropped HID message: no SimDeviceLegacyHIDClient")
            return false
        }
        return transmit(client)
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
    /// (HIDError 2) drops later input until a send completes without error
    /// or `notReadyLimit` has passed. Late errors from a client that was
    /// already replaced are ignored.
    public func clientReported(_ reporter: Client, domain: String, code: Int) {
        guard reporter === client else { return }
        if HIDDeliveryGate.isClientDisconnected(domain: domain, code: code) {
            gate.noteClientDisconnected()
            notReady = false
            notReadySince = nil
            loggedNotReady = false
            return
        }
        guard HIDDeliveryGate.isClientNotReady(domain: domain, code: code) else { return }
        if !notReady {
            notReady = true
            notReadySince = now()
            loggedNotReady = false
        }
    }

    /// A successful send completion from `reporter` clears the not-ready
    /// flag: the guest accepted input, so later sends can be acked again.
    public func clientReportedSuccess(_ reporter: Client) {
        guard reporter === client else { return }
        notReady = false
        notReadySince = nil
        loggedNotReady = false
    }

    /// See `HIDDeliveryGate.noteNotification`.
    public func noteDeviceNotification(_ info: [AnyHashable: Any]) {
        gate.noteNotification(info)
    }

    /// After the gate has admitted the device as Booted, drop input while
    /// the current client is still reporting HIDError 2 (iOS starting up).
    private func admitReady() -> Bool {
        guard notReady else { return true }
        let started = notReadySince ?? now()
        if now() - started >= notReadyLimit {
            notReady = false
            notReadySince = nil
            loggedNotReady = false
            return true
        }
        if !loggedNotReady {
            log(Self.notReadyMessage)
            loggedNotReady = true
        }
        return false
    }
}
