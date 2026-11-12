import Foundation

/// Runs a `SimDevice.state` probe (or a test double) without stalling the HID
/// input path.
///
/// `-[SimDevice state]` is usually a cheap in-process KVC read, and locally it
/// leaves Booted within ~100ms of `simctl shutdown`. On some hosts the same
/// read blocks for several seconds because shutdown holds a CoreSimulator
/// lock — CI on macos-26 recorded the first post-shutdown `tap` returning
/// only after 6.3s. A synchronous read on the injector's actor queue would
/// hang the ack that long. This reader runs the probe on a private queue,
/// waits up to `timeout`, coalesces overlapping probes onto one in-flight
/// read, and reports `.timedOut` so the gate can drop the input instead.
public final class BoundedStateReader: @unchecked Sendable {
    public enum Probe: Equatable, Sendable {
        case ready(Int?)
        case timedOut
    }

    public static let defaultTimeout: TimeInterval = 0.1

    private let read: () -> Int?
    private let timeout: TimeInterval
    private let queue: DispatchQueue
    private let lock = NSCondition()
    /// Waiters hold the `Flight` they joined, so a later probe starting a
    /// new read cannot reset this flight's completion out from under them.
    private final class Flight {
        var finished = false
        var value: Int?
        var timedOut = false
    }
    private var inFlight: Flight?
    /// Callers currently inside `probe()` for tests that need to wait until
    /// an overlapping caller has joined the in-flight read.
    private(set) var waiterCount = 0

    public init(timeout: TimeInterval = BoundedStateReader.defaultTimeout, read: @escaping () -> Int?) {
        self.timeout = timeout
        self.read = read
        self.queue = DispatchQueue(label: "hid-delivery-gate.state", qos: .userInteractive)
    }

    public func probe() -> Probe {
        lock.lock()
        defer { lock.unlock() }
        waiterCount += 1
        defer { waiterCount -= 1 }

        let flight: Flight
        if let current = inFlight {
            flight = current
            // An earlier caller already waited out this flight; don't pile
            // another `timeout` onto every subsequent tap.
            if flight.timedOut {
                return .timedOut
            }
        } else {
            flight = Flight()
            inFlight = flight
            let read = self.read
            queue.async { [self] in
                let result = read()
                self.lock.lock()
                flight.value = result
                flight.finished = true
                if self.inFlight === flight {
                    self.inFlight = nil
                }
                self.lock.broadcast()
                self.lock.unlock()
            }
        }

        let deadline = Date().addingTimeInterval(timeout)
        while !flight.finished {
            if !lock.wait(until: deadline) {
                flight.timedOut = true
                return .timedOut
            }
        }
        return .ready(flight.value)
    }
}
