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

    /// The device set serve-sim targets, found by `lookup`, which sends
    /// CoreSimulator's `selector` with `path`: `deviceSetWithPath:error:` and
    /// the path for a configured set, `defaultDeviceSetWithError:` and nil for
    /// Xcode's default. Nil when `lookup` finds no set.
    public static func lookUp<Found>(_ lookup: (_ selector: String, _ path: String?) -> Found?) -> Found? {
        let path = path()
        return lookup(path == nil ? "defaultDeviceSetWithError:" : "deviceSetWithPath:error:", path)
    }

    /// `xcrun` arguments that run `simctl <arguments>` against the configured set.
    public static func simctlArguments(_ arguments: [String]) -> [String] {
        guard let path = path() else { return ["simctl"] + arguments }
        return ["simctl", "--set", path] + arguments
    }
}
