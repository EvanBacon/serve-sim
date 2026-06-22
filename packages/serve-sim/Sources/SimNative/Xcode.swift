import Foundation

enum Xcode {
    /// Absolute path to the active Xcode's Developer dir (`xcode-select -p`),
    /// e.g. `/Applications/Xcode.app/Contents/Developer`. Falls back to the
    /// default install path if `xcode-select` can't be run.
    static func developerDir() -> String {
        let fallback = "/Applications/Xcode.app/Contents/Developer"
        let pipe = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        process.arguments = ["-p"]
        process.standardOutput = pipe
        // Only read output if the process actually launched; otherwise
        // waitUntilExit() on an unstarted process traps.
        do {
            try process.run()
        } catch {
            return fallback
        }
        process.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? fallback
    }
}
