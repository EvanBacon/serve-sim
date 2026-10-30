import XCTest
import XPC
@testable import SimNativeSupport

final class DTUHIDMessagesTests: XCTestCase {
    func testTouchWireTypesAndPhases() throws {
        for (type, phase): (String, UInt64) in [("begin", 0), ("move", 1), ("end", 2)] {
            let message = try XCTUnwrap(DTUHIDMessages.touch(type: type, x: 0.2, y: 0.8, edge: 3))
            XCTAssertEqual(String(cString: xpc_dictionary_get_string(message, "messageType")!), "IndigoDigitizerEvent")
            let payload = try XCTUnwrap(xpc_dictionary_get_value(message, "payload"))
            XCTAssertTrue(xpc_get_type(xpc_dictionary_get_value(payload, "eventType")!) == XPC_TYPE_UINT64)
            XCTAssertEqual(xpc_dictionary_get_uint64(payload, "eventType"), phase)
            XCTAssertEqual(xpc_dictionary_get_uint64(payload, "edge"), 3)
            XCTAssertEqual(xpc_dictionary_get_uint64(payload, "target"), 0)
            XCTAssertNil(xpc_dictionary_get_value(payload, "pointTwo"))
            let point = try XCTUnwrap(xpc_dictionary_get_value(payload, "pointOne"))
            XCTAssertEqual(xpc_dictionary_get_double(point, "x"), 0.2)
            XCTAssertEqual(xpc_dictionary_get_double(point, "y"), 0.8)
        }
        XCTAssertNil(DTUHIDMessages.touch(type: "invalid", x: 0, y: 0))
    }

    func testKeyboardStateIsOneBasedAndEnvelopeIsNotBarrier() throws {
        for (down, state): (Bool, UInt64) in [(true, 1), (false, 2)] {
            let message = DTUHIDMessages.key(usage: 4, down: down)
            XCTAssertFalse(xpc_dictionary_get_bool(message, "isBarrier"))
            XCTAssertEqual(String(cString: xpc_dictionary_get_string(message, "featureIdentifier")!), DTUHIDMessages.service)
            let payload = try XCTUnwrap(xpc_dictionary_get_value(message, "payload"))
            XCTAssertEqual(xpc_dictionary_get_uint64(payload, "state"), state)
            XCTAssertEqual(xpc_dictionary_get_uint64(payload, "usageCode"), 4)
        }
    }

    func testSecondContactIsExplicit() throws {
        let message = try XCTUnwrap(DTUHIDMessages.touch(type: "begin", x: 0.1, y: 0.2, second: CGPoint(x: 0.7, y: 0.9)))
        let payload = try XCTUnwrap(xpc_dictionary_get_value(message, "payload"))
        let point = try XCTUnwrap(xpc_dictionary_get_value(payload, "pointTwo"))
        XCTAssertEqual(xpc_dictionary_get_double(point, "x"), 0.7)
        XCTAssertEqual(xpc_dictionary_get_double(point, "y"), 0.9)
    }
}
