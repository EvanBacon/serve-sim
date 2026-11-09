import Foundation

/// Runs the Home button's SpringBoard launch on its own serial queue so a slow
/// launch never occupies the HID actor's executor, where it would queue later
/// touches, buttons, and display operations behind it.
///
/// The direct CoreSimulator call is tried first; the fallback runs only if that
/// API is unavailable or the launch fails. Presses that arrive while a launch
/// is in flight join it rather than queueing another one, and resume with it.
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
    private let log: @Sendable (String) -> Void
    private let lock = NSLock()
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(log: @escaping @Sendable (String) -> Void = SpringBoardLauncher.logToStderr) {
        self.log = log
    }

    /// Presses currently waiting on the in-flight launch, including its initiator.
    var waiterCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return waiters.count
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
                switch direct() {
                case .launched:
                    break
                case .unavailable:
                    fallback()
                case .failed(let message):
                    log("[hid] Direct SpringBoard launch failed: \(message)")
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
        // Brief grace period so the common case is fully gone before the next launch.
        _ = exited.wait(timeout: .now() + 1)
        return false
    }

    /// Writes one line to stderr; the default `log` destination.
    @Sendable
    public static func logToStderr(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
