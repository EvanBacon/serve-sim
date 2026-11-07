/*
 Guest XPC connection sequence adapted from Meta idb.

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
import Foundation
import ObjectiveC
import XPC
import Darwin
import SimNativeSupport

/// Xcode 27's guest digitizer transport. Protocol reference: Meta idb's
/// FBSimulatorControl/HID/DTUHIDModels.swift and XPC/SimulatorXPCConnection.swift.
/// Kept opt-in until the supported runtime/device matrix has been exercised.
final class DTUHIDBridge {
    private let connection: xpc_connection_t
    private let service = "com.apple.coredevice.feature.remote.hid.digitizer"
    private let queue = DispatchQueue(label: "serve-sim.dtuhid")

    init(device: NSObject) throws {
        func failure(_ reason: String) -> NSError {
            NSError(domain: "DTUHIDBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
        }
        typealias Lookup = @convention(c) (AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> mach_port_t
        typealias Endpoint = @convention(c) (mach_port_t, UInt64, UInt64) -> Unmanaged<AnyObject>?
        typealias Connect = @convention(c) (xpc_object_t) -> Unmanaged<AnyObject>?
        typealias Enable = @convention(c) (xpc_connection_t) -> Void
        let sel = NSSelectorFromString("lookup:error:")
        guard device.responds(to: sel),
              let lookup = class_getMethodImplementation(object_getClass(device), sel),
              let endpointSymbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "xpc_endpoint_create_mach_port_4sim"),
              let connectSymbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "xpc_connection_create_from_endpoint"),
              let enableSymbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "xpc_connection_enable_sim2host_4sim") else {
            throw failure("Guest XPC symbols unavailable")
        }
        var error: NSError?
        let port = unsafeBitCast(lookup, to: Lookup.self)(device, sel, service as NSString, &error)
        guard port != MACH_PORT_NULL else { throw error ?? failure("Digitizer service unavailable") }
        guard let endpoint = unsafeBitCast(endpointSymbol, to: Endpoint.self)(port, 0, 0)?.takeRetainedValue() as? xpc_object_t,
              let conn = unsafeBitCast(connectSymbol, to: Connect.self)(endpoint)?.takeRetainedValue() as? xpc_connection_t else {
            throw failure("Cannot connect to guest digitizer")
        }
        connection = conn
        unsafeBitCast(enableSymbol, to: Enable.self)(conn)
        xpc_connection_set_target_queue(conn, queue)
        xpc_connection_set_event_handler(conn) { event in
            if xpc_get_type(event) == XPC_TYPE_ERROR {
                print("[hid] DTUHID connection interrupted/invalidated; reconnect mirror before continuing input")
            }
        }
        xpc_connection_resume(conn)
        // A port existing does not prove a live daemon. Probe before accepting input.
        let payload = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_uint64(payload, "usageCode", 0)
        xpc_dictionary_set_uint64(payload, "state", 2)
        let probe = DTUHIDMessages.envelope("IndigoKeyboardButtonEvent", payload, barrier: true)
        let ready = DispatchSemaphore(value: 0)
        let result = ProbeResult()
        xpc_connection_send_message_with_reply(conn, probe, queue) { reply in
            result.ok = xpc_get_type(reply) != XPC_TYPE_ERROR
            ready.signal()
        }
        guard ready.wait(timeout: .now() + 4) == .success, result.ok else {
            xpc_connection_cancel(conn)
            throw failure("Guest digitizer did not answer liveness probe")
        }
        Thread.sleep(forTimeInterval: 0.2)
        print("[hid] DTUHID digitizer connected and acknowledged")
    }

    private final class ProbeResult: @unchecked Sendable { var ok = false }

    deinit { xpc_connection_cancel(connection) }

    func touch(type: String, x: Double, y: Double, second: CGPoint? = nil, edge: UInt32 = 0) {
        guard let message = DTUHIDMessages.touch(type: type, x: x, y: y, second: second, edge: edge) else { return }
        xpc_connection_send_message(connection, message)
    }

    func key(usage: UInt32, down: Bool) {
        xpc_connection_send_message(connection, DTUHIDMessages.key(usage: usage, down: down))
    }
}
