/// Fold poses for iPhone Duo (V68).
///
/// The hinge service transmits a commanded angle to the simulated device. Closed is ~0°, fully open / flat is ~180°. The cover
/// display selection uses a 90° heuristic until guest panel-state readback
/// is available. It is not a measurement of SpringBoard's switching threshold.
/// Do not toggle SimScreen power — FrontBoard's bookend display monitor
/// asserts if a foldable panel is missing at SpringBoard launch.
public struct DevicePoseSpec: Equatable, Sendable {
    public let name: String
    public let hingeDegrees: Double
    public let coverActive: Bool
    public let preferredWidth: Int
    public let preferredHeight: Int

    public init(
        name: String,
        hingeDegrees: Double,
        coverActive: Bool,
        preferredWidth: Int,
        preferredHeight: Int
    ) {
        self.name = name
        self.hingeDegrees = hingeDegrees
        self.coverActive = coverActive
        self.preferredWidth = preferredWidth
        self.preferredHeight = preferredHeight
    }
}

public enum DevicePose {
    public static let coverWidth = 1398
    public static let coverHeight = 2034
    public static let innerWidth = 2007
    public static let innerHeight = 2853

    /// Cover stays the active panel below this hinge angle.
    public static let coverActiveBelowDegrees = 90.0

    /// Duo's own Integrated screen registrations, including SimulatorHID's mask.
    /// Do not apply this mapping to TVOut, CarPlay, or single-panel devices.
    public static func touchTarget(width: Int, height: Int) -> UInt32? {
        let size = [width, height].sorted()
        if size == [coverWidth, coverHeight] { return 0x40000001 }
        if size == [innerWidth, innerHeight] { return 0x40000003 }
        return nil
    }

    public static let presets: [DevicePoseSpec] = [
        spec("closed", hingeDegrees: 0),
        spec("tent", hingeDegrees: 80),
        spec("tabletop", hingeDegrees: 100),
        spec("book", hingeDegrees: 130),
        spec("open", hingeDegrees: 180),
    ]

    public static func spec(_ name: String, hingeDegrees: Double) -> DevicePoseSpec {
        let coverActive = hingeDegrees < coverActiveBelowDegrees
        return DevicePoseSpec(
            name: name,
            hingeDegrees: hingeDegrees,
            coverActive: coverActive,
            preferredWidth: coverActive ? coverWidth : innerWidth,
            preferredHeight: coverActive ? coverHeight : innerHeight
        )
    }

    public static func preset(named raw: String) -> DevicePoseSpec? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if name == "cover" { return preset(named: "closed") }
        if name == "inner" || name == "openflat" || name == "flat" {
            return preset(named: "open")
        }
        return presets.first { $0.name == name }
    }

    public static func spec(hingeDegrees: Double) -> DevicePoseSpec {
        spec("custom", hingeDegrees: hingeDegrees)
    }
}
