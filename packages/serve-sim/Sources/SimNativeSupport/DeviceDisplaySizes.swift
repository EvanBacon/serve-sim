import Foundation

/// Reads native framebuffer sizes from a CoreSimulator device-type
/// `capabilities.plist`. Foldables list more than one integrated digitizer
/// display (iPhone Duo: 1398×2034 cover + 2007×2853 inner); presentation
/// surfaces such as the 7680×4320 resizable scene have no chrome identifier
/// and are ignored.
public enum DeviceDisplaySizes {
    public static func nativeSizes(fromCapabilitiesPlist data: Data) -> [FramebufferSurfaceSize] {
        guard let plist = try? PropertyListSerialization.propertyList(
            from: data,
            options: [],
            format: nil
        ) else {
            return []
        }
        let root = plist as? [String: Any] ?? [:]
        let capabilities = (root["capabilities"] as? [String: Any]) ?? root
        let displays = capabilities["displays"] as? [[String: Any]] ?? []

        var sizes: [FramebufferSurfaceSize] = []
        for display in displays {
            guard (display["displayType"] as? String) == "integrated" else { continue }
            guard boolValue(display["hasDigitizer"]) else { continue }
            let chrome = display["chromeIdentifier"] as? String ?? ""
            guard !chrome.isEmpty else { continue }
            let width = intValue(display["width"])
            let height = intValue(display["height"])
            guard width > 0, height > 0 else { continue }
            sizes.append(FramebufferSurfaceSize(width: width, height: height))
        }
        return sizes
    }

    private static func boolValue(_ value: Any?) -> Bool {
        if let flag = value as? Bool { return flag }
        if let number = value as? NSNumber { return number.boolValue }
        return false
    }

    private static func intValue(_ value: Any?) -> Int {
        if let number = value as? Int { return number }
        if let number = value as? NSNumber { return number.intValue }
        if let number = value as? Double { return Int(number.rounded()) }
        if let number = value as? Float { return Int(number.rounded()) }
        return 0
    }
}
