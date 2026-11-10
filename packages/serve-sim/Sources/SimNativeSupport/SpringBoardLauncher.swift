import Foundation

/// Runs the Home button's SpringBoard launch on its own serial queue so a slow
/// launch never occupies the HID actor's executor, where it would queue later
/// touches, buttons, and display operations behind it.
///
/// The direct CoreSimulator call is tried first; the fallback runs only if that
/// API is unavailable, the launch fails, or it doesn't return within
/// `directTimeout`. Presses that arrive while a launch is in flight join it
/// rather than queueing another one, and resume with it.
///
/// A blocked CoreSimulator call can't be cancelled, so a direct launch that
/// times out is abandoned on its own queue. Until it returns, later presses go
/// straight to the fallback instead of stacking more calls behind it; once it
/// returns, the direct path is used again.
public final class SpringBoardLauncher: @unchecked Sendable {
    public enum DirectResult: Sendable {
        case launched
        /// The direct launch API doesn't exist on this CoreSimulator version.
        case unavailable
        case failed(String)
    }

    private let queue = DispatchQueue(
        label: "serve-sim.springboard-launch",
        qos: .userInteractive,
        autoreleaseFrequency: .workItem
    )
    /// Runs `direct` so the launch queue can stop waiting on it at the timeout.
    private let directQueue = DispatchQueue(
        label: "serve-sim.springboard-launch.direct",
        qos: .userInteractive,
        autoreleaseFrequency: .workItem
    )
    private let directTimeout: TimeInterval
    private let log: @Sendable (String) -> Void
    private let lock = NSLock()
    private var waiters: [CheckedContinuation<Void, Never>] = []
    /// A timed-out direct launch that hasn't returned yet.
    private var abandonedDirectLaunch = false

    /// Outcome of one direct call, claimed under `lock` by whichever of the
    /// call's return or the timeout gets there first.
    private enum DirectState {
        case pending
        case finished(DirectResult)
        case abandoned
    }

    private final class DirectAttempt: @unchecked Sendable {
        var state = DirectState.pending
    }

    public init(
        directTimeout: TimeInterval = 10,
        log: @escaping @Sendable (String) -> Void = SpringBoardLauncher.logToStderr
    ) {
        self.directTimeout = directTimeout
        self.log = log
    }

    /// Presses currently waiting on the in-flight launch, including its initiator.
    var waiterCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return waiters.count
    }

    /// Whether a timed-out direct launch is still blocked in CoreSimulator.
    var isDirectLaunchAbandoned: Bool {
        lock.lock()
        defer { lock.unlock() }
        return abandonedDirectLaunch
    }

    /// Runs `direct`, then `fallback` if it didn't launch, on the launcher's
    /// queue. Returns when the attempt this press started or joined finishes.
    public func launch(
        direct: @escaping @Sendable () -> DirectResult,
        fallback: @escaping @Sendable () -> Void
    ) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            waiters.append(continuation)
            let isFirst = waiters.count == 1
            lock.unlock()
            guard isFirst else { return }

            queue.async { [self] in
                switch runDirect(direct) {
                case .launched?:
                    break
                case .unavailable?:
                    fallback()
                case .failed(let message)?:
                    log("[hid] Direct SpringBoard launch failed: \(message)")
                    fallback()
                case nil:
                    fallback()
                }

                lock.lock()
                let finished = waiters
                waiters = []
                lock.unlock()
                finished.forEach { $0.resume() }
            }
        }
    }

    /// Runs `direct` on `directQueue` and blocks the launch queue until it
    /// returns or `directTimeout` passes. Returns nil if it timed out or a
    /// previously abandoned call is still blocked; either way, use the fallback.
    private func runDirect(_ direct: @escaping @Sendable () -> DirectResult) -> DirectResult? {
        lock.lock()
        let blocked = abandonedDirectLaunch
        lock.unlock()
        if blocked {
            log("[hid] Previous direct SpringBoard launch is still blocked; using fallback")
            return nil
        }

        let attempt = DirectAttempt()
        let returned = DispatchSemaphore(value: 0)
        directQueue.async { [self] in
            let result = direct()
            lock.lock()
            let wasAbandoned: Bool
            if case .abandoned = attempt.state {
                wasAbandoned = true
                abandonedDirectLaunch = false
            } else {
                wasAbandoned = false
                attempt.state = .finished(result)
            }
            lock.unlock()
            returned.signal()
            if wasAbandoned {
                log("[hid] Timed-out direct SpringBoard launch returned; direct launches re-enabled")
            }
        }
        _ = returned.wait(timeout: .now() + directTimeout)

        lock.lock()
        if case .finished(let result) = attempt.state {
            lock.unlock()
            return result
        }
        attempt.state = .abandoned
        abandonedDirectLaunch = true
        lock.unlock()
        log("[hid] Direct SpringBoard launch timed out after \(directTimeout)s; using fallback")
        return nil
    }

    /// Starts `process` and blocks until it exits, terminating it after `timeout`
    /// so a hung child can't hold up later launches forever. Call only from a
    /// thread that may block, such as a `fallback`. Returns whether the process
    /// started and exited within `timeout`.
    @discardableResult
    public static func runToExit(
        _ process: Process,
        timeout: TimeInterval,
        log: @Sendable (String) -> Void = SpringBoardLauncher.logToStderr
    ) -> Bool {
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        guard (try? process.run()) != nil else { return false }
        if exited.wait(timeout: .now() + timeout) == .success { return true }

        log("[hid] \(process.executableURL?.path ?? "process") timed out after \(timeout)s; terminating")
        process.terminate()
        // Give SIGTERM a short grace period, then SIGKILL (which can't be ignored)
        // so a timed-out child is gone before the next launch can start.
        if exited.wait(timeout: .now() + 1) == .timedOut {
            kill(process.processIdentifier, SIGKILL)
            _ = exited.wait(timeout: .now() + 5)
        }
        return false
    }

    /// Writes one line to stderr; the default `log` destination.
    @Sendable
    public static func logToStderr(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
