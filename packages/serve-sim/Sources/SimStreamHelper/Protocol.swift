import Foundation

// WebSocket binary message types (used for input only now)
enum WSMessageType: UInt8 {
    case touch = 0x03          // client → server: JSON touch event
    case button = 0x04         // client → server: JSON button event
    case multiTouch = 0x05     // client → server: JSON multi-touch event
    case key = 0x06            // client → server: JSON keyboard event
    case orientation = 0x07    // client → server: JSON orientation event
    case caDebug = 0x08        // client → server: JSON CoreAnimation debug toggle
    case memoryWarning = 0x09  // client → server: empty body, triggers [SimDevice simulateMemoryWarning]
    case digitalCrown = 0x0A   // client → server: JSON Digital Crown rotation event
    case scroll = 0x0B         // client → server: JSON scroll-wheel / trackpad pan event
    case toggleSoftwareKeyboard = 0x0C // client → server: empty body, toggles the on-screen keyboard
}

struct TouchEventPayload: Codable {
    let type: String   // "begin", "move", "end"
    let x: Double      // normalized 0..1
    let y: Double      // normalized 0..1
    let edge: UInt32?  // IndigoHIDEdge value (0=none, 3=bottom, etc.) — omit for regular touches
}

struct ButtonEventPayload: Codable {
    let button: String     // named button ("home", "lock", …) — used when page/usage absent
    /// Optional HID usage page (e.g. 12 = Consumer) for an arbitrary hardware
    /// button injected via IndigoHIDMessageForHIDArbitrary. Carried straight from
    /// DeviceKit chrome.json's per-input `usagePage`/`usage`.
    let page: UInt32?
    let usage: UInt32?
    /// "down", "up", or "press" (down + brief hold + up). Defaults to "press"
    /// when omitted, so a CLI tap is a momentary press while the UI can hold
    /// power / side buttons for their long-press menus via explicit down/up.
    let phase: String?
}

struct MultiTouchEventPayload: Codable {
    let type: String    // "begin", "move", "end"
    let x1: Double      // finger 1 normalized 0..1
    let y1: Double
    let x2: Double      // finger 2 normalized 0..1
    let y2: Double
}

struct KeyEventPayload: Codable {
    let type: String    // "down", "up"
    let usage: UInt32   // USB HID Usage Page 0x07 keyboard code
}

struct OrientationEventPayload: Codable {
    // "portrait", "portrait_upside_down", "landscape_left", "landscape_right"
    let orientation: String
}

struct DigitalCrownEventPayload: Codable {
    /// Raw scroll delta to feed through SimulatorKit's Digital Crown HID event.
    let delta: Double
}

struct ScrollEventPayload: Codable {
    /// Scroll deltas as a fraction of the display (normalized, raw device
    /// orientation). Positive `dy` scrolls content down. The server scales these
    /// by the screen dimensions before handing them to the scroll HID event.
    let dx: Double
    let dy: Double
    /// Normalized (0–1, raw device orientation) cursor position the scroll
    /// happened over. The touch-drag that emulates the scroll begins here so iOS
    /// pans the view under the pointer (e.g. a bottom modal vs. the map behind
    /// it). Optional for backwards compatibility; defaults to the screen center.
    let x: Double?
    let y: Double?
}

// Simulator.app's Debug menu toggles map to `-[SimDevice setCADebugOption:enabled:]`
// with these option names (observed in Simulator.app's binary):
//   debug_color_blended, debug_color_copies, debug_color_misaligned,
//   debug_color_offscreen, debug_slow_animations
struct CADebugEventPayload: Codable {
    let option: String
    let enabled: Bool
}
