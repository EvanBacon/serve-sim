import Foundation

// C-ABI wrapper around AccessibilityBridge (reused verbatim from
// SimStreamHelper). Powers the in-process /ax and /foreground endpoints that the
// spawned helper used to serve. Both are one-shot dumps — the SSE polling stays
// on the JS side (src/ax.ts). Returns heap-allocated JSON the caller frees, or
// nil on error (writing a message to errOut).

@_cdecl("sim_ax_describe")
public func sim_ax_describe(
    _ udid: UnsafePointer<CChar>,
    _ errOut: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
) -> UnsafeMutablePointer<CChar>? {
    do {
        SimFrameworks.load()  // self-sufficient: /ax may be hit before capture/HID load them
        let data = try AccessibilityBridge.shared.describeUI(udid: String(cString: udid))
        return strdup(String(decoding: data, as: UTF8.self))
    } catch {
        errOut.pointee = strdup(error.localizedDescription)
        return nil
    }
}

@_cdecl("sim_ax_frontmost")
public func sim_ax_frontmost(
    _ udid: UnsafePointer<CChar>,
    _ errOut: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
) -> UnsafeMutablePointer<CChar>? {
    do {
        SimFrameworks.load()
        let info = try AccessibilityBridge.shared.frontmostApp(udid: String(cString: udid))
        let data = try JSONSerialization.data(withJSONObject: info)
        return strdup(String(decoding: data, as: UTF8.self))
    } catch {
        errOut.pointee = strdup(error.localizedDescription)
        return nil
    }
}
