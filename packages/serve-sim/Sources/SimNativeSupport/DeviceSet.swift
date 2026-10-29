import Foundation

/// The CoreSimulator device set serve-sim targets: Xcode's default set, or
/// the one `serve-sim --device-set` names (`simctl --set`). The JS side
/// resolves it once and hands it to the addon with `setDeviceSet` as it
/// loads the addon, before any capture, input or accessibility call.
public enum DeviceSet {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var configuredPath: String?

    public static func configure(path: String?) {
        lock.withLock { configuredPath = path }
    }

    /// The configured set's path, or nil for Xcode's default set.
    public static func path() -> String? {
        lock.withLock { configuredPath }
    }

    /// `xcrun` arguments that run `simctl <arguments>` against the configured set.
    public static func simctlArguments(_ arguments: [String]) -> [String] {
        guard let path = path() else { return ["simctl"] + arguments }
        return ["simctl", "--set", path] + arguments
    }
}
