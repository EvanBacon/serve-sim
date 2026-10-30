import Foundation
import XPC

/// Typed XPC wire format used by the guest dtuhidd service.
public enum DTUHIDMessages {
    public static let service = "com.apple.coredevice.feature.remote.hid.digitizer"
    public static func envelope(_ kind: String, _ payload: xpc_object_t, barrier: Bool = false) -> xpc_object_t {
        let message = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_string(message, "messageType", kind)
        xpc_dictionary_set_string(message, "featureIdentifier", service)
        xpc_dictionary_set_bool(message, "isBarrier", barrier)
        xpc_dictionary_set_value(message, "payload", payload)
        return message
    }

    public static func touch(type: String, x: Double, y: Double, second: CGPoint? = nil, edge: UInt32 = 0) -> xpc_object_t? {
        let phase: UInt64
        switch type {
        case "begin": phase = 0
        case "move": phase = 1
        case "end": phase = 2
        default: return nil
        }
        func point(_ x: Double, _ y: Double) -> xpc_object_t {
            let p = xpc_dictionary_create(nil, nil, 0)
            xpc_dictionary_set_double(p, "x", x)
            xpc_dictionary_set_double(p, "y", y)
            return p
        }
        let payload = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_value(payload, "pointOne", point(x, y))
        if let second { xpc_dictionary_set_value(payload, "pointTwo", point(second.x, second.y)) }
        xpc_dictionary_set_uint64(payload, "eventType", phase)
        xpc_dictionary_set_uint64(payload, "edge", UInt64(edge))
        xpc_dictionary_set_uint64(payload, "target", 0)
        return envelope("IndigoDigitizerEvent", payload)
    }

    public static func key(usage: UInt32, down: Bool) -> xpc_object_t {
        let payload = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_uint64(payload, "usageCode", UInt64(usage))
        xpc_dictionary_set_uint64(payload, "state", down ? 1 : 2)
        return envelope("IndigoKeyboardButtonEvent", payload)
    }
}
