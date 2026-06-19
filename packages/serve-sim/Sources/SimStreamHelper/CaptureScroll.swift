import Foundation
import ObjectiveC
import AppKit

/// Diagnostic: start a real `SimHIDCaptureManager` capture session (the exact
/// path Device Hub uses) and hexdump every `IndigoHIDMessage` that
/// `SimDeviceLegacyHIDClient` sends to the guest. Do a real two-finger trackpad
/// scroll during the capture window to record the ground-truth scroll bytes.
///
/// Usage: serve-sim-bin --capture-scroll <udid> [seconds]
enum CaptureScroll {
    static func run(udid: String, seconds: Double) {
        SimFrameworks.load()
        guard let device = FrameCapture.findSimDevice(udid: udid) else {
            fputs("[capture] device \(udid) not found\n", stderr)
            exit(1)
        }

        installSendHook()

        guard let mgrClass = NSClassFromString("SimHIDCaptureManager") as? NSObject.Type else {
            fputs("[capture] SimHIDCaptureManager not found\n", stderr)
            exit(1)
        }
        let sharedSel = NSSelectorFromString("sharedManager")
        guard let mgr = mgrClass.perform(sharedSel)?.takeUnretainedValue() as? NSObject else {
            fputs("[capture] sharedManager failed\n", stderr)
            exit(1)
        }

        // -startCaptureSessionWithDevice:hidDeviceTypes:error:  (0x2 = pointer)
        let startSel = NSSelectorFromString("startCaptureSessionWithDevice:hidDeviceTypes:error:")
        typealias StartFn = @convention(c) (AnyObject, Selector, AnyObject, UInt64, AutoreleasingUnsafeMutablePointer<NSError?>?) -> Bool
        guard let startIMP = mgr.method(for: startSel) else {
            fputs("[capture] no startCaptureSession IMP\n", stderr)
            exit(1)
        }
        let startFn = unsafeBitCast(startIMP, to: StartFn.self)

        print("[capture] ====================================================")
        print("[capture] Capture session starting on \(udid).")
        print("[capture] >>> DO A TWO-FINGER TRACKPAD SCROLL NOW (\(Int(seconds))s window) <<<")
        print("[capture] The host cursor is hidden while captured; scroll is")
        print("[capture] forwarded to the simulator. Bytes are logged below.")
        print("[capture] ====================================================")

        var err: NSError?
        let ok = startFn(mgr, startSel, device, 0x2, &err)
        if !ok {
            fputs("[capture] startCaptureSession failed: \(String(describing: err))\n", stderr)
            exit(1)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            let stopSel = NSSelectorFromString("stopCaptureSession")
            _ = mgr.perform(stopSel)
            print("[capture] capture stopped; \(messageCount) messages logged.")
            exit(0)
        }
        CFRunLoopRun()
    }

    static var messageCount = 0

    private static func installSendHook() {
        guard let cls = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else { return }
        let sel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        guard let method = class_getInstanceMethod(cls, sel) else {
            fputs("[capture] sendWithMessage method not found\n", stderr)
            return
        }
        let origIMP = method_getImplementation(method)
        typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
        let origFn = unsafeBitCast(origIMP, to: SendFn.self)

        let block: @convention(block) (AnyObject, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void = { obj, msg, freeWhenDone, q, completion in
            dump(msg)
            origFn(obj, sel, msg, freeWhenDone, q, completion)
        }
        method_setImplementation(method, imp_implementationWithBlock(block))
        print("[capture] hooked SimDeviceLegacyHIDClient.sendWithMessage")
    }

    private static func dump(_ msg: UnsafeMutableRawPointer) {
        messageCount += 1
        let len = malloc_size(msg)
        let b = msg.assumingMemoryBound(to: UInt8.self)
        func u32(_ off: Int) -> UInt32 { off + 4 <= len ? msg.load(fromByteOffset: off, as: UInt32.self) : 0 }
        func u8(_ off: Int) -> UInt8 { off < len ? b[off] : 0 }
        func dbl(_ off: Int) -> Double { off + 8 <= len ? msg.load(fromByteOffset: off, as: Double.self) : .nan }

        // Decode the fields we mapped from the RE.
        let kind = u8(0x1c)
        let rec0Type = u32(0x20)
        let rec1Type = u32(0xc0)
        let targetA = u32(0x4c)
        let label: String
        switch rec1Type {
        case 6: label = "SCROLL"
        case 0xb: label = "TRACKPAD/MOVE"
        case 0x11: label = "POINTER"
        default: label = (kind == 1 ? "CREATE-SERVICE" : "OTHER")
        }

        var hex = ""
        for i in 0..<min(len, 0x160) {
            hex += String(format: "%02x", b[i])
            if (i + 1) % 32 == 0 { hex += "\n           " }
        }

        print("[capture] #\(messageCount) \(label) len=\(len) kind=\(kind) rec0Type=0x\(String(rec0Type, radix:16)) rec1Type=0x\(String(rec1Type, radix:16)) target=0x\(String(targetA, radix:16))")
        if rec1Type == 6 {
            print("[capture]   scrollX=\(dbl(0xd4)) scrollY=\(dbl(0xdc)) scrollZ=\(dbl(0xe4)) flags=0x\(String(u32(0xcc), radix:16)) phase=\(u32(0xf4)) momentum=\(u32(0xf8))")
        }
        print("[capture]   hex: \(hex)")
    }
}
