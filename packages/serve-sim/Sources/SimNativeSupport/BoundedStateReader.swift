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
    private var inFlight = false
    private var finished = false
    private var value: Int?
    private var timedOutThisFlight = false

    public init(timeout: TimeInterval = BoundedStateReader.defaultTimeout, read: @escaping () -> Int?) {
        self.timeout = timeout
        self.read = read
        self.queue = DispatchQueue(label: "hid-delivery-gate.state", qos: .userInteractive)
    }

    public func probe() -> Probe {
        lock.lock()
        defer { lock.unlock() }

        if !inFlight {
            inFlight = true
            finished = false
            timedOutThisFlight = false
            value = nil
            let read = self.read
            queue.async { [self] in
                let result = read()
                self.lock.lock()
                self.value = result
                self.finished = true
                self.inFlight = false
                self.lock.broadcast()
                self.lock.unlock()
            }
        } else if timedOutThisFlight && !finished {
            // An earlier caller already waited out this flight; don't pile
            // another `timeout` onto every subsequent tap.
            return .timedOut
        }

        let deadline = Date().addingTimeInterval(timeout)
        while !finished {
            if !lock.wait(until: deadline) {
                timedOutThisFlight = true
                return .timedOut
            }
        }
        return .ready(value)
    }
}
