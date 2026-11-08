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

    @Sendable
    public static func logToStderr(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
