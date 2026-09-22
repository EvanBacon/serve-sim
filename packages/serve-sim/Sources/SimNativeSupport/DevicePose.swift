/// Named hinge angles for iPhone Duo (V68).
///
/// Which framebuffer is live is decided in TypeScript from SpringBoard's
/// primary-panel readback, with the 90° rule only before that readback.
/// Touch routing uses the captured pixel size (`touchTarget`), not the pose.
/// Do not toggle SimScreen power — FrontBoard's bookend display monitor
/// asserts if a foldable panel is missing at SpringBoard launch.
public struct DevicePoseSpec: Equatable, Sendable {
    public let name: String
    public let hingeDegrees: Double

    public init(name: String, hingeDegrees: Double) {
        self.name = name
        self.hingeDegrees = hingeDegrees
    }
}

public enum DevicePose {
    public static let coverWidth = 1398
    public static let coverHeight = 2034
    public static let innerWidth = 2007
    public static let innerHeight = 2853

    /// Duo's own Integrated screen registrations, including SimulatorHID's mask.
    /// Do not apply this mapping to TVOut, CarPlay, or single-panel devices.
    public static func touchTarget(width: Int, height: Int) -> UInt32? {
        let size = [width, height].sorted()
        if size == [coverWidth, coverHeight] { return 0x40000001 }
        if size == [innerWidth, innerHeight] { return 0x40000003 }
        return nil
    }

    public static let presets: [DevicePoseSpec] = [
        DevicePoseSpec(name: "closed", hingeDegrees: 0),
        DevicePoseSpec(name: "tent", hingeDegrees: 80),
        DevicePoseSpec(name: "tabletop", hingeDegrees: 100),
        DevicePoseSpec(name: "book", hingeDegrees: 130),
        DevicePoseSpec(name: "open", hingeDegrees: 180),
    ]

    public static func preset(named raw: String) -> DevicePoseSpec? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if name == "cover" { return preset(named: "closed") }
        if name == "inner" || name == "openflat" || name == "flat" {
            return preset(named: "open")
        }
        return presets.first { $0.name == name }
    }
}
