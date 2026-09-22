import Foundation
import Darwin

/// A lazily started guest service. Calls are serialized by HIDInjector's actor;
/// replies acknowledge dispatch, so a failed command never switches capture.
final class DuoHIDBridge {
    private let udid: String
    private let executable: String
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?

    init(udid: String, executable: String) {
        self.udid = udid
        self.executable = executable
    }

    deinit { stop() }

    private func stop() {
        try? input?.close()
        try? output?.close()
        if let process, process.isRunning { process.terminate() }
        process = nil
        input = nil
        output = nil
    }

    func send(_ command: String) -> Bool {
        do {
            if process?.isRunning != true {
                stop()
                guard FileManager.default.isExecutableFile(atPath: executable) else { return false }
                let child = Process()
                let stdin = Pipe(), stdout = Pipe()
                child.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
                child.arguments = ["simctl", "spawn", udid, executable]
                child.standardInput = stdin
                child.standardOutput = stdout
                child.standardError = FileHandle.standardError
                try child.run()
                process = child
                input = stdin.fileHandleForWriting
                output = stdout.fileHandleForReading
            }
            guard let input, let output else { return false }
            try input.write(contentsOf: Data((command + "\n").utf8))
            let deadline = Date().addingTimeInterval(3)
            var reply = Data()
            while Date() < deadline && reply.count < 64 {
                var descriptor = pollfd(fd: output.fileDescriptor, events: Int16(POLLIN), revents: 0)
                let remaining = max(1, Int32(deadline.timeIntervalSinceNow * 1000))
                guard poll(&descriptor, 1, remaining) > 0,
                      let byte = try output.read(upToCount: 1), !byte.isEmpty else { break }
                if byte[0] == 10 { return String(data: reply, encoding: .utf8) == "OK" }
                reply.append(byte)
            }
        } catch {
            print("[hid] Duo guest command failed: \(error)")
        }
        stop()
        return false
    }
}
