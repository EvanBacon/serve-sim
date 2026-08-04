import Foundation

public struct DeviceHubWindow: Equatable, Sendable {
    public let processIdentifier: Int32
    public let windowNumber: UInt32
    public let name: String
    public let layer: Int
    public let isOnScreen: Bool

    public init(
        processIdentifier: Int32,
        windowNumber: UInt32,
        name: String,
        layer: Int = 0,
        isOnScreen: Bool = true
    ) {
        self.processIdentifier = processIdentifier
        self.windowNumber = windowNumber
        self.name = name
        self.layer = layer
        self.isOnScreen = isOnScreen
    }
}

public enum DeviceHubWindowRoutingFailure: Error, Equatable, Sendable, CustomStringConvertible {
    case noEligibleWindows
    case targetNotFound
    case ambiguousTarget(count: Int)
    case targetNotFrontmost(frontmostName: String)

    public var description: String {
        switch self {
        case .noEligibleWindows:
            return "Device Hub has no visible simulator window"
        case .targetNotFound:
            return "the target simulator window is not visible"
        case .ambiguousTarget(let count):
            return "the target simulator name matches \(count) windows"
        case .targetNotFrontmost(let frontmostName):
            return "another Device Hub window is frontmost (\(frontmostName))"
        }
    }
}

/// Chooses a Device Hub simulator window from CGWindowList's front-to-back
/// ordering. A simulator name is not globally unique, so duplicate matches are
/// deliberately rejected instead of risking keyboard input in the wrong guest.
public enum DeviceHubWindowRouter {
    public static func route(
        windows: [DeviceHubWindow],
        processIdentifier: Int32,
        targetDeviceName: String
    ) -> Result<DeviceHubWindow, DeviceHubWindowRoutingFailure> {
        let eligible = windows.filter {
            $0.processIdentifier == processIdentifier
                && $0.layer == 0
                && $0.isOnScreen
                && !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard let frontmost = eligible.first else { return .failure(.noEligibleWindows) }

        let matches = eligible.filter { $0.name == targetDeviceName }
        guard !matches.isEmpty else { return .failure(.targetNotFound) }
        guard matches.count == 1 else { return .failure(.ambiguousTarget(count: matches.count)) }
        guard matches[0].windowNumber == frontmost.windowNumber else {
            return .failure(.targetNotFrontmost(frontmostName: frontmost.name))
        }
        return .success(matches[0])
    }
}

public enum HIDModifier: Equatable, Sendable {
    case control
    case shift
    case option
    case command
}

/// USB HID Keyboard/Keypad usage (page 0x07) to macOS virtual key code.
public enum HIDKeyboardMapping {
    public static func macVirtualKeyCode(for usage: UInt32) -> UInt16? {
        keyCodes[usage]
    }

    public static func modifier(for usage: UInt32) -> HIDModifier? {
        switch usage {
        case 0xE0, 0xE4: return .control
        case 0xE1, 0xE5: return .shift
        case 0xE2, 0xE6: return .option
        case 0xE3, 0xE7: return .command
        default: return nil
        }
    }

    private static let keyCodes: [UInt32: UInt16] = [
        // A-Z
        0x04: 0,  0x05: 11, 0x06: 8,  0x07: 2,  0x08: 14, 0x09: 3,
        0x0A: 5,  0x0B: 4,  0x0C: 34, 0x0D: 38, 0x0E: 40, 0x0F: 37,
        0x10: 46, 0x11: 45, 0x12: 31, 0x13: 35, 0x14: 12, 0x15: 15,
        0x16: 1,  0x17: 17, 0x18: 32, 0x19: 9,  0x1A: 13, 0x1B: 7,
        0x1C: 16, 0x1D: 6,

        // Number row
        0x1E: 18, 0x1F: 19, 0x20: 20, 0x21: 21, 0x22: 23,
        0x23: 22, 0x24: 26, 0x25: 28, 0x26: 25, 0x27: 29,

        // Editing and punctuation
        0x28: 36, 0x29: 53, 0x2A: 51, 0x2B: 48, 0x2C: 49,
        0x2D: 27, 0x2E: 24, 0x2F: 33, 0x30: 30, 0x31: 42,
        0x32: 42, 0x33: 41, 0x34: 39, 0x35: 50, 0x36: 43,
        0x37: 47, 0x38: 44, 0x39: 57,

        // Function keys
        0x3A: 122, 0x3B: 120, 0x3C: 99,  0x3D: 118, 0x3E: 96, 0x3F: 97,
        0x40: 98,  0x41: 100, 0x42: 101, 0x43: 109, 0x44: 103, 0x45: 111,
        0x46: 105, 0x47: 107, 0x48: 113,

        // Navigation
        0x49: 114, 0x4A: 115, 0x4B: 116, 0x4C: 117, 0x4D: 119,
        0x4E: 121, 0x4F: 124, 0x50: 123, 0x51: 125, 0x52: 126,

        // Numeric keypad
        0x53: 71, 0x54: 75, 0x55: 67, 0x56: 78, 0x57: 69, 0x58: 76,
        0x59: 83, 0x5A: 84, 0x5B: 85, 0x5C: 86, 0x5D: 87, 0x5E: 88,
        0x5F: 89, 0x60: 91, 0x61: 92, 0x62: 82, 0x63: 65,
        0x64: 10, 0x67: 81,

        // Media keys commonly emitted by browsers
        0x7F: 74, 0x80: 72, 0x81: 73,

        // Modifiers
        0xE0: 59, 0xE1: 56, 0xE2: 58, 0xE3: 55,
        0xE4: 62, 0xE5: 60, 0xE6: 61, 0xE7: 54,
    ]
}
