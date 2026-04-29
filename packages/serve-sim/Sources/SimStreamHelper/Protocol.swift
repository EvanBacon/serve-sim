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
}

struct TouchEventPayload: Codable {
    let type: String   // "begin", "move", "end"
    let x: Double      // normalized 0..1
    let y: Double      // normalized 0..1
    let edge: UInt32?  // IndigoHIDEdge value (0=none, 3=bottom, etc.) — omit for regular touches
}

struct ButtonEventPayload: Codable {
    let button: String  // "home"
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

// Simulator.app's Debug menu toggles map to `-[SimDevice setCADebugOption:enabled:]`
// with these option names (observed in Simulator.app's binary):
//   debug_color_blended, debug_color_copies, debug_color_misaligned,
//   debug_color_offscreen, debug_slow_animations
struct CADebugEventPayload: Codable {
    let option: String
    let enabled: Bool
}
