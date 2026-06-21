import Foundation

// C-ABI wrapper around the existing HIDInjector (reused verbatim from
// SimStreamHelper). The Objective-C++ N-API layer (sim-native.mm) calls these;
// the opaque handle is an Unmanaged<HIDInjector> pointer. All the reverse-
// engineered Indigo/mach logic lives in HIDInjector.swift — this file only
// marshals C types across the boundary.

private func injector(_ handle: UnsafeMutableRawPointer) -> HIDInjector {
    Unmanaged<HIDInjector>.fromOpaque(handle).takeUnretainedValue()
}

/// Create + set up a HID injector for `udid`. Returns an opaque handle, or nil
/// on failure (writing a heap-allocated message to `errOut`, caller frees).
@_cdecl("sim_hid_create")
public func sim_hid_create(
    _ udid: UnsafePointer<CChar>,
    _ errOut: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
) -> UnsafeMutableRawPointer? {
    let injector = HIDInjector()
    do {
        try injector.setup(deviceUDID: String(cString: udid))
    } catch {
        errOut.pointee = strdup(error.localizedDescription)
        return nil
    }
    return Unmanaged.passRetained(injector).toOpaque()
}

/// Release a handle from sim_hid_create.
@_cdecl("sim_hid_destroy")
public func sim_hid_destroy(_ handle: UnsafeMutableRawPointer) {
    Unmanaged<HIDInjector>.fromOpaque(handle).release()
}

@_cdecl("sim_hid_touch")
public func sim_hid_touch(
    _ handle: UnsafeMutableRawPointer,
    _ type: UnsafePointer<CChar>, _ x: Double, _ y: Double,
    _ screenWidth: Int32, _ screenHeight: Int32, _ edge: UInt32
) {
    injector(handle).sendTouch(type: String(cString: type), x: x, y: y,
                               screenWidth: Int(screenWidth), screenHeight: Int(screenHeight),
                               edge: edge)
}

@_cdecl("sim_hid_multi_touch")
public func sim_hid_multi_touch(
    _ handle: UnsafeMutableRawPointer,
    _ type: UnsafePointer<CChar>,
    _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double,
    _ screenWidth: Int32, _ screenHeight: Int32
) {
    injector(handle).sendMultiTouch(type: String(cString: type), x1: x1, y1: y1, x2: x2, y2: y2,
                                    screenWidth: Int(screenWidth), screenHeight: Int(screenHeight))
}

@_cdecl("sim_hid_button")
public func sim_hid_button(
    _ handle: UnsafeMutableRawPointer,
    _ button: UnsafePointer<CChar>, _ udid: UnsafePointer<CChar>
) {
    injector(handle).sendButton(button: String(cString: button), deviceUDID: String(cString: udid))
}

@_cdecl("sim_hid_button_hid")
public func sim_hid_button_hid(
    _ handle: UnsafeMutableRawPointer,
    _ page: UInt32, _ usage: UInt32, _ phase: UnsafePointer<CChar>
) {
    injector(handle).sendButtonHID(page: page, usage: usage, phase: String(cString: phase))
}

@_cdecl("sim_hid_key")
public func sim_hid_key(
    _ handle: UnsafeMutableRawPointer,
    _ type: UnsafePointer<CChar>, _ usage: UInt32
) {
    injector(handle).sendKey(type: String(cString: type), usage: usage)
}

/// Pass NaN for anchorX/anchorY to mean "center" (the Swift API's nil).
@_cdecl("sim_hid_scroll")
public func sim_hid_scroll(
    _ handle: UnsafeMutableRawPointer,
    _ dx: Double, _ dy: Double, _ anchorX: Double, _ anchorY: Double,
    _ screenWidth: Int32, _ screenHeight: Int32
) {
    injector(handle).sendScroll(dx: dx, dy: dy,
                                anchorX: anchorX.isNaN ? nil : anchorX,
                                anchorY: anchorY.isNaN ? nil : anchorY,
                                screenWidth: Int(screenWidth), screenHeight: Int(screenHeight))
}

@_cdecl("sim_hid_digital_crown")
public func sim_hid_digital_crown(_ handle: UnsafeMutableRawPointer, _ delta: Double) {
    injector(handle).sendDigitalCrown(delta: delta)
}

@_cdecl("sim_hid_orientation")
public func sim_hid_orientation(_ handle: UnsafeMutableRawPointer, _ orientation: UInt32) -> Bool {
    injector(handle).sendOrientation(orientation: orientation)
}

@_cdecl("sim_hid_memory_warning")
public func sim_hid_memory_warning(_ handle: UnsafeMutableRawPointer) {
    injector(handle).simulateMemoryWarning()
}

@_cdecl("sim_hid_software_keyboard")
public func sim_hid_software_keyboard(_ handle: UnsafeMutableRawPointer) {
    injector(handle).toggleSoftwareKeyboard()
}

@_cdecl("sim_hid_ca_debug")
public func sim_hid_ca_debug(
    _ handle: UnsafeMutableRawPointer,
    _ name: UnsafePointer<CChar>, _ enabled: Bool
) -> Bool {
    injector(handle).setCADebugOption(name: String(cString: name), enabled: enabled)
}
