import Foundation

enum SimFrameworks {
    /// Loads the private simulator frameworks (CoreSimulator + SimulatorKit) into
    /// the process.
    ///
    /// These are used purely through the Objective-C runtime (NSClassFromString /
    /// KVC / selectors), never linked or imported, so they're dlopen'd from the
    /// active Xcode rather than declared in Package.swift. That keeps the binary
    /// free of an `@rpath/SimulatorKit` load command whose location is
    /// version-specific — Xcode 27 moved SimulatorKit from
    /// `Developer/Library/PrivateFrameworks` to `Contents/SharedFrameworks`.
    static func load() {
        let dev = Xcode.developerDir()
        // CoreSimulator ships an absolute install name and is also installed
        // system-wide; SimulatorKit lives inside Xcode and moved in 27.
        let candidates = [
            "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
            "\(dev)/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
            "\(dev)/../SharedFrameworks/SimulatorKit.framework/SimulatorKit",       // Xcode 27+
            "\(dev)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", // Xcode 26 and older
        ]
        for path in candidates { _ = dlopen(path, RTLD_NOW) }
    }
}
