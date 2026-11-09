import Foundation
import XCTest
@testable import SimNativeSupport

/// Thread-safe call log; the launcher runs its closures on its own queue.
private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    func record(_ entry: String) {
        lock.lock()
        entries.append(entry)
        lock.unlock()
    }

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }
}

/// Stands in for `HIDInjector`: if the launcher blocked its caller, `ping()`
/// could not run on this actor until the slow launch finished.
private actor FakeInjector {
    let launcher: SpringBoardLauncher

    init(launcher: SpringBoardLauncher) {
        self.launcher = launcher
    }

    func pressHome(
        direct: @escaping @Sendable () -> SpringBoardLauncher.DirectResult,
        fallback: @escaping @Sendable () -> Void
    ) async {
        await launcher.launch(direct: direct, fallback: fallback)
    }

    func ping() -> Bool { true }
}

final class SpringBoardLauncherTests: XCTestCase {
    func testDirectSuccessSkipsFallback() async {
        let recorder = Recorder()
        let launcher = SpringBoardLauncher()

        await launcher.launch(
            direct: { recorder.record("direct"); return .launched },
            fallback: { recorder.record("fallback") }
        )

        XCTAssertEqual(recorder.all, ["direct"])
    }

    func testMissingSelectorFallsBack() async {
        let recorder = Recorder()
        let launcher = SpringBoardLauncher()

        await launcher.launch(
            direct: { recorder.record("direct"); return .unavailable },
            fallback: { recorder.record("fallback") }
        )

        XCTAssertEqual(recorder.all, ["direct", "fallback"])
    }

    func testDirectFailureFallsBackAndLogs() async {
        let recorder = Recorder()
        let launcher = SpringBoardLauncher(log: { recorder.record("log: \($0)") })

        await launcher.launch(
            direct: { recorder.record("direct"); return .failed("boom") },
            fallback: { recorder.record("fallback") }
        )

        XCTAssertEqual(recorder.all.first, "direct")
        XCTAssertEqual(recorder.all.last, "fallback")
        XCTAssertEqual(recorder.all.count, 3)
        XCTAssertTrue(recorder.all[1].contains("boom"), "unexpected log: \(recorder.all[1])")
    }

    func testActorStaysResponsiveDuringSlowDirectLaunch() async {
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let injector = FakeInjector(launcher: SpringBoardLauncher())

        let press = Task {
            await injector.pressHome(
                direct: {
                    started.signal()
                    release.wait()
                    return .launched
                },
                fallback: {}
            )
        }

        // Wait off the cooperative pool so a blocked launcher can't starve it.
        let didStart = await Self.wait(for: started, timeout: 5)
        XCTAssertTrue(didStart, "direct launch never started")

        // Safety release so a launcher that blocks the actor fails this test
        // rather than deadlocking it.
        let recorder = Recorder()
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            recorder.record("released")
            release.signal()
        }

        // The direct launch is still blocked here; the actor must serve this.
        let responded = await injector.ping()
        recorder.record("pinged")
        XCTAssertTrue(responded)
        XCTAssertEqual(recorder.all.first, "pinged", "actor was blocked by the direct launch")

        release.signal()
        await press.value
    }

    func testLaunchRunsOnDedicatedQueueNotTheCooperativePool() async {
        let recorder = Recorder()
        let launcher = SpringBoardLauncher()

        await launcher.launch(
            direct: {
                recorder.record(String(cString: __dispatch_queue_get_label(nil)))
                return .unavailable
            },
            fallback: { recorder.record(String(cString: __dispatch_queue_get_label(nil))) }
        )

        XCTAssertEqual(recorder.all, Array(repeating: "serve-sim.springboard-launch", count: 2))
    }

    func testConcurrentPressesCoalesceWhileLaunchIsInFlight() async {
        let recorder = Recorder()
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let launcher = SpringBoardLauncher()

        let first = Task {
            await launcher.launch(
                direct: {
                    recorder.record("direct")
                    started.signal()
                    release.wait()
                    return .launched
                },
                fallback: { recorder.record("fallback") }
            )
        }
        let didStart = await Self.wait(for: started, timeout: 5)
        XCTAssertTrue(didStart, "direct launch never started")

        let extras = (0..<8).map { _ in
            Task {
                await launcher.launch(
                    direct: { recorder.record("extra-direct"); return .launched },
                    fallback: { recorder.record("extra-fallback") }
                )
            }
        }

        // Release only once every extra has joined; release even on failure so
        // the launcher's queue can't stay blocked past the end of the test.
        let didJoin = await Self.waitForWaiters(on: launcher, count: 9, timeout: 5)
        release.signal()
        XCTAssertTrue(didJoin, "extra presses never joined the in-flight launch")

        await first.value
        for extra in extras { await extra.value }
        XCTAssertEqual(recorder.all, ["direct"])
    }

    func testLaunchesAgainAfterPreviousCompletes() async {
        let recorder = Recorder()
        let launcher = SpringBoardLauncher()

        for _ in 0..<3 {
            await launcher.launch(
                direct: { recorder.record("direct"); return .launched },
                fallback: { recorder.record("fallback") }
            )
        }

        XCTAssertEqual(recorder.all, ["direct", "direct", "direct"])
    }

    func testRunToExitWaitsForProcessToFinish() throws {
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("springboard-launcher-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: marker) }
        let process = Self.shell("sleep 0.2; touch '\(marker.path)'")

        XCTAssertTrue(SpringBoardLauncher.runToExit(process, timeout: 10))

        XCTAssertFalse(process.isRunning)
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path), "returned before the process finished")
    }

    func testRunToExitTerminatesHungProcessAtTimeout() {
        let recorder = Recorder()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]

        XCTAssertFalse(SpringBoardLauncher.runToExit(process, timeout: 0.1, log: { recorder.record($0) }))

        XCTAssertFalse(process.isRunning, "hung process was left running")
        XCTAssertEqual(recorder.all.count, 1, "unexpected log: \(recorder.all)")
    }

    func testRunToExitKillsProcessThatIgnoresSIGTERM() {
        let recorder = Recorder()
        // The loop is bounded (~30s) so the shell can't outlive a crashed test run.
        let process = Self.shell(
            "trap '' TERM; i=0; while [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done"
        )
        // Only reached with a live child if the escalation regresses.
        defer { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }

        // Long enough for the shell to install its trap before SIGTERM arrives.
        XCTAssertFalse(SpringBoardLauncher.runToExit(process, timeout: 2, log: { recorder.record($0) }))

        // `terminationStatus` raises if read while the process is still running.
        guard !process.isRunning else {
            return XCTFail("process that ignored SIGTERM was left running")
        }
        // SIGTERM would report 15, so this proves the trap held and SIGKILL landed.
        XCTAssertEqual(process.terminationReason, .uncaughtSignal)
        XCTAssertEqual(process.terminationStatus, SIGKILL)
        // Capture errno immediately; XCTest calls in between could overwrite it.
        let probe = kill(process.processIdentifier, 0)
        let probeErrno = errno
        XCTAssertEqual(probe, -1, "process still exists")
        XCTAssertEqual(probeErrno, ESRCH)
        XCTAssertEqual(recorder.all.count, 1, "unexpected log: \(recorder.all)")
    }

    func testRunToExitReturnsWhenProcessCannotStart() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/nonexistent/serve-sim-test-binary")

        XCTAssertFalse(SpringBoardLauncher.runToExit(process, timeout: 10))
    }

    private static func shell(_ command: String) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        return process
    }

    /// Polls until `count` presses are waiting on the in-flight launch.
    private static func waitForWaiters(
        on launcher: SpringBoardLauncher,
        count: Int,
        timeout: TimeInterval
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while launcher.waiterCount < count {
            guard Date() < deadline else { return false }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return true
    }

    private static func wait(for semaphore: DispatchSemaphore, timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: semaphore.wait(timeout: .now() + timeout) == .success)
            }
        }
    }
}
