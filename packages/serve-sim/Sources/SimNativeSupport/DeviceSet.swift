import Foundation

/// The CoreSimulator device set serve-sim targets: Xcode's default set, or
/// the one `serve-sim --device-set` names (`simctl --set`). The CLI hands it
/// to the addon with `setDeviceSet`, since a JS `process.env` write does not
/// reach the native environment under Bun, and to the processes it starts
/// as `SERVE_SIM_DEVICE_SET`.
public enum DeviceSet {
    public static let environmentKey = "SERVE_SIM_DEVICE_SET"

    private static let lock = NSLock()
    nonisolated(unsafe) private static var configuredPath: String?

    /// Set by the CLI through the addon; wins over the environment.
    public static func configure(path: String?) {
        lock.withLock { configuredPath = path.flatMap(nonBlank) }
    }

    /// The configured set's path, or nil for Xcode's default set.
    public static func path(in environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        lock.withLock { configuredPath } ?? environment[environmentKey].flatMap(nonBlank)
    }

    /// `xcrun` arguments that run `simctl <arguments>` against the configured set.
    public static func simctlArguments(
        _ arguments: [String],
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> [String] {
        guard let path = path(in: environment) else { return ["simctl"] + arguments }
        return ["simctl", "--set", path] + arguments
    }

    private static func nonBlank(_ value: String) -> String? {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
    }
}
