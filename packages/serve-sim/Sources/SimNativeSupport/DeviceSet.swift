import Foundation

/// The CoreSimulator device set serve-sim targets: Xcode's default set, or
/// the one `serve-sim --device-set` names, which the CLI hands to the addon
/// and to every helper it starts as `SERVE_SIM_DEVICE_SET` (`simctl --set`).
public enum DeviceSet {
    public static let environmentKey = "SERVE_SIM_DEVICE_SET"

    /// The configured set's path, or nil for Xcode's default set.
    public static func path(in environment: [String: String]) -> String? {
        guard let path = environment[environmentKey],
              !path.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return path
    }

    /// `xcrun` arguments that run `simctl <arguments>` against the configured set.
    public static func simctlArguments(_ arguments: [String], environment: [String: String]) -> [String] {
        guard let path = path(in: environment) else { return ["simctl"] + arguments }
        return ["simctl", "--set", path] + arguments
    }
}
