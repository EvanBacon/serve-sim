import Foundation
import ObjectiveC
import Darwin
import CoreGraphics
import SimNativeSupport

/// Per-event HID logging is gated behind `SERVE_SIM_DEBUG_HID`. These lines fire
/// on every touch/move/button/key/crown event — a single drag emits a dozen —
/// so by default they flood stdout (and anything mirroring it) for no benefit.
/// Failure diagnostics ("returned nil", "unavailable", "not found") stay on
/// `print` so real problems are always visible.
private let hidDebugEnabled = ProcessInfo.processInfo.environment["SERVE_SIM_DEBUG_HID"] != nil

@inline(__always)
private func hidLog(_ message: @autoclosure () -> String) {
    guard hidDebugEnabled else { return }
    print(message())
    // stdout is fully buffered when redirected to a log file; flush so each
    // debug line is observable as the event happens (the type e2e test tails
    // the server log for these).
    fflush(stdout)
}

/// Carries the `SimDevice` to `SpringBoardLauncher`'s queue. The object is
/// never mutated from Swift; the launch only sends it one message.
private struct UncheckedSimDevice: @unchecked Sendable {
    let device: NSObject
}

/// Injects touch, button, and orientation HID events into the iOS Simulator.
///
/// Uses IndigoHIDMessageForMouseNSEvent to create touch messages and
/// IndigoHIDMessageForButton for hardware button presses, sent via
/// SimDeviceLegacyHIDClient. Orientation goes through a separate transport
/// (PurpleWorkspacePort / GSEvent mach messages), matching idb's approach.
///
/// The real C signature for touch is:
///   IndigoHIDMessageForMouseNSEvent(CGPoint*, CGPoint*, IndigoHIDTarget, NSEventType, NSSize, IndigoHIDEdge)
/// On arm64: x0=CGPoint*, x1=CGPoint*/NULL, x2=target, x3=eventType, d0/d1=NSSize, x4=edge.
/// Apple's Simulator.app always passes NSSize(1.0, 1.0), making ratio = point / 1.0 = point.
/// The edge parameter (x4) controls whether iOS treats the touch as a system edge gesture
/// (e.g. bottom edge = swipe-to-home on Face ID devices).
actor HIDInjector {
    let queue = DispatchSerialQueue(label: "hid-injector", qos: .userInteractive)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    /// The SimDeviceLegacyHIDClient, behind the device-state gate. It drops
    /// input once the device leaves Booted and rebuilds the client when the same
    /// device boots again; see `HIDClientChannel`.
    private var channel = HIDClientChannel<NSObject>(
        gate: HIDDeliveryGate { nil }, connect: { nil }, log: HIDInjector.logLine
    )
    private static let sendSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
    /// Send completion for `completionClient`. It is built once per client, not per send,
    /// and runs on `queue`, which is this actor's executor.
    private var completion: AnyObject?
    private weak var completionClient: NSObject?
    private var notificationHandlerID: UInt?
    private var simDevice: NSObject?
    private let springBoardLauncher = SpringBoardLauncher()
    private var deviceHubKeyboardBridge: DeviceHubKeyboardBridge?

    // IndigoHIDMessageForMouseNSEvent(CGPoint*, CGPoint*, IndigoHIDTarget, NSEventType, NSSize, IndigoHIDEdge)
    // arm64 ABI: pointer/int params → x0-x4, float params → d0-d1 (independent numbering).
    // CGFloat params map to d0 (NSSize.width) and d1 (NSSize.height).
    private typealias IndigoMouseFunc = @convention(c) (
        UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?, UInt32, Int32, CGFloat, CGFloat, UInt32
    ) -> UnsafeMutableRawPointer?
    private var mouseFunc: IndigoMouseFunc?

    // IndigoHIDMessageForButton(int eventSource, int direction, int target) -> IndigoMessage*
    private typealias IndigoButtonFunc = @convention(c) (Int32, Int32, Int32) -> UnsafeMutableRawPointer?
    private var buttonFunc: IndigoButtonFunc?

    // IndigoHIDMessageForHIDArbitrary(uint32 target, uint32 page, uint32 usage, uint32 direction) -> IndigoMessage*
    // direction: 1 = down, 2 = up. Routes any (page, usage) HID pair — used for
    // power / volume / action / side buttons whose codes ship in DeviceKit's
    // chrome.json. Unlike IndigoHIDMessageForButton's home press, these are
    // delivered to the digitizer target and are honored on Xcode 26.
    private typealias IndigoHIDArbitraryFunc = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
    private var hidArbitraryFunc: IndigoHIDArbitraryFunc?

    // IndigoHIDMessageForKeyboardArbitrary(uint32_t keyCode, uint32_t direction) -> IndigoMessage*
    // direction: 1 = key down, 2 = key up
    private typealias IndigoKeyboardFunc = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?
    private var keyboardFunc: IndigoKeyboardFunc?

    // IndigoHIDMessageForDigitalCrownEvent(double rotationalDelta) -> IndigoMessage*
    private typealias IndigoDigitalCrownFunc = @convention(c) (Double) -> UnsafeMutableRawPointer?
    private var digitalCrownFunc: IndigoDigitalCrownFunc?

    private var duoBridge: DuoHIDBridge?
    private var touchTarget: UInt32 = 0x32

    // NOTE: scroll is NOT a native HID event on the simulator — see the "Scroll
    // events" section below. Device Hub's trackpad-capture path requires private
    // Apple HID entitlements an unprivileged helper can't have, and synthetic
    // scroll events are ignored by iOS, so we scroll via a touch drag instead.

    func setup(deviceUDID: String, duoHelper: String) throws {
        SimFrameworks.load()
        guard let device = FrameCapture.findSimDevice(udid: deviceUDID) else {
            throw NSError(domain: "HIDInjector", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Device \(deviceUDID) not found"])
        }
        self.simDevice = device
        if let type = device.value(forKey: "deviceType") as? NSObject,
           let identifier = type.value(forKey: "identifier") as? String,
           identifier == "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo" {
            duoBridge = DuoHIDBridge(udid: deviceUDID, executable: duoHelper)
            touchTarget = 0x40000001 // Duo's integrated cover; never the shared 0x32 slot.
        }

        guard let funcPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForMouseNSEvent") else {
            throw NSError(domain: "HIDInjector", code: 5,
                          userInfo: [NSLocalizedDescriptionKey: "IndigoHIDMessageForMouseNSEvent not found"])
        }
        self.mouseFunc = unsafeBitCast(funcPtr, to: IndigoMouseFunc.self)

        if let buttonPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForButton") {
            self.buttonFunc = unsafeBitCast(buttonPtr, to: IndigoButtonFunc.self)
            hidLog("[hid] IndigoHIDMessageForButton loaded")
        } else {
            print("[hid] Warning: IndigoHIDMessageForButton not found")
        }

        if let arbPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForHIDArbitrary") {
            self.hidArbitraryFunc = unsafeBitCast(arbPtr, to: IndigoHIDArbitraryFunc.self)
            hidLog("[hid] IndigoHIDMessageForHIDArbitrary loaded")
        } else {
            print("[hid] Warning: IndigoHIDMessageForHIDArbitrary not found")
        }

        if let keyboardPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForKeyboardArbitrary") {
            self.keyboardFunc = unsafeBitCast(keyboardPtr, to: IndigoKeyboardFunc.self)
            hidLog("[hid] IndigoHIDMessageForKeyboardArbitrary loaded")
        } else {
            print("[hid] Warning: IndigoHIDMessageForKeyboardArbitrary not found")
        }

        if let crownPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForDigitalCrownEvent") {
            self.digitalCrownFunc = unsafeBitCast(crownPtr, to: IndigoDigitalCrownFunc.self)
            hidLog("[hid] IndigoHIDMessageForDigitalCrownEvent loaded")
        } else {
            print("[hid] Warning: IndigoHIDMessageForDigitalCrownEvent not found")
        }


        // Read on every admit (a plain in-process KVC read).
        let gate = device.responds(to: NSSelectorFromString("state"))
            ? HIDDeliveryGate { (device.value(forKey: "state") as? NSNumber)?.intValue }
            : HIDDeliveryGate { nil }
        // Thrown errors here fail setup, as before.
        let firstClient = try Self.makeHIDClient(device: device)
        let duo = duoBridge
        channel = HIDClientChannel(
            gate: gate,
            connect: {
                do { return try Self.makeHIDClient(device: device) } catch {
                    print("[hid] Could not create SimDeviceLegacyHIDClient: \(error.localizedDescription)")
                    return nil
                }
            },
            log: Self.logLine,
            // The Duo guest helper ran inside the old boot; start a new one.
            // Weak so `close()` can still release the bridge (and its helper).
            didReconnect: { [weak duo] in duo?.reset() }
        )
        channel.adopt(firstClient)
        registerStateNotifications(device: device)
        // DeviceHubKeyboardBridge needs no reconnect: it holds no device port, only
        // Device Hub's (host app) pid, which it re-validates on every key-down.
        let deviceName = device.value(forKey: "name") as? String ?? deviceUDID
        let runtimeName = (device.value(forKey: "runtime") as? NSObject)?
            .value(forKey: "name") as? String
        self.deviceHubKeyboardBridge = DeviceHubKeyboardBridge.makeIfSupported(
            deviceUDID: deviceUDID,
            deviceName: deviceName,
            runtimeName: runtimeName
        )
        hidLog("[hid] SimDeviceLegacyHIDClient created")
        hidLog("[hid] IndigoHIDMessageForMouseNSEvent loaded (with edge gesture support)")
    }

    private static func logLine(_ line: String) {
        print(line)
        fflush(stdout)
    }

    /// A new SimDeviceLegacyHIDClient for the device's current boot.
    private static func makeHIDClient(device: NSObject) throws -> NSObject {
        guard let hidClass = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else {
            throw NSError(domain: "HIDInjector", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "SimDeviceLegacyHIDClient not found"])
        }

        let initSel = NSSelectorFromString("initWithDevice:error:")
        typealias HIDInitFunc = @convention(c) (AnyObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
        guard let initIMP = class_getMethodImplementation(hidClass, initSel) else {
            throw NSError(domain: "HIDInjector", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "Cannot get init method"])
        }
        let initFunc = unsafeBitCast(initIMP, to: HIDInitFunc.self)

        var error: NSError?
        let client = initFunc(hidClass.alloc(), initSel, device, &error)
        if let error { throw error }
        guard let clientObj = client as? NSObject else {
            throw NSError(domain: "HIDInjector", code: 4,
                          userInfo: [NSLocalizedDescriptionKey: "Failed to create HID client"])
        }
        return clientObj
    }

    /// Watch `device_state` so a shutdown + boot with no input in between still
    /// rebuilds the client: then the gate only ever reads Booted. The handler
    /// runs on `queue`, this actor's executor, so it never races the channel.
    private func registerStateNotifications(device: NSObject) {
        let sel = NSSelectorFromString("registerNotificationHandlerOnQueue:handler:")
        guard device.responds(to: sel) else { return }
        let channel = self.channel
        let handler: @convention(block) (NSDictionary?) -> Void = { [weak channel] info in
            guard let info = info as? [AnyHashable: Any] else { return }
            channel?.noteDeviceNotification(info)
        }
        typealias RegisterFunc = @convention(c) (AnyObject, Selector, AnyObject, AnyObject) -> UInt
        notificationHandlerID = unsafeBitCast(device.method(for: sel), to: RegisterFunc.self)(
            device, sel, queue, handler as AnyObject)
    }

    private func unregisterStateNotifications() {
        let sel = NSSelectorFromString("unregisterNotificationHandler:error:")
        guard let id = notificationHandlerID, let device = simDevice, device.responds(to: sel) else { return }
        notificationHandlerID = nil
        typealias UnregisterFunc = @convention(c) (AnyObject, Selector, UInt, AutoreleasingUnsafeMutablePointer<NSError?>) -> ObjCBool
        var error: NSError?
        _ = unsafeBitCast(device.method(for: sel), to: UnregisterFunc.self)(device, sel, id, &error)
    }

    /// The completion block for sends through `client`. A HIDError 3 from it
    /// ("Mach port invalid, device disconnected") makes the next input rebuild
    /// the client. The send that hit it was already acked: waiting for the
    /// completion would add its round trip to every send.
    private func completion(for client: NSObject) -> AnyObject {
        if let completion, completionClient === client { return completion }
        let channel = self.channel
        let block: @convention(block) (NSError?) -> Void = { [weak channel, weak client] error in
            guard let error, let channel, let client else { return }
            channel.clientReported(client, domain: error.domain, code: error.code)
        }
        completion = block as AnyObject
        completionClient = client
        return block as AnyObject
    }

    // IndigoHIDEdge values (x4 param to IndigoHIDMessageForMouseNSEvent).
    // These control system edge gesture recognition in the simulated iOS device.
    // Determined by disassembling IndigoHIDMessageForMouseNSEvent and testing
    // each value against a booted Face ID simulator.
    static let edgeNone: UInt32   = 0  // No edge — regular touch
    static let edgeBottom: UInt32 = 3  // Bottom edge — swipe-to-home on Face ID devices
    static let edgeTop: UInt32    = 2  // Top edge (notification center)
    static let edgeLeft: UInt32   = 1  // Left edge
    static let edgeRight: UInt32  = 4  // Right edge

    /// Synchronously hand an already-built Indigo message to the guest, freeing it.
    /// Must run on `inputQueue`. Returns false when there is no HID client to
    /// send through (setup never completed) or the device is no longer booted,
    /// so callers can report the drop.
    @discardableResult
    private func rawSend(_ msg: UnsafeMutableRawPointer) -> Bool {
        var handedOff = false
        let sent = channel.send { client in
            typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
            guard let sendIMP = class_getMethodImplementation(object_getClass(client)!, Self.sendSel) else { return false }
            // freeWhenDone: the client owns `msg` from here.
            unsafeBitCast(sendIMP, to: SendFunc.self)(client, Self.sendSel, msg, ObjCBool(true), queue, completion(for: client))
            handedOff = true
            return true
        }
        if !handedOff { free(msg) }
        return sent
    }

    /// Build a single-finger touch message (normalized 0..1 coords). Pure — safe
    /// to call off `inputQueue`. NSSize(1,1) makes ratio = point.
    private func touchMessage(type: String, x: Double, y: Double, edge: UInt32) -> UnsafeMutableRawPointer? {
        guard let mouseFunc = mouseFunc else { return nil }
        let eventType: Int32
        switch type {
        case "begin", "move": eventType = 1  // Down (C function rejects Dragged=6)
        case "end":           eventType = 2  // Up
        default: return nil
        }
        var point = CGPoint(x: x, y: y)
        return mouseFunc(&point, nil, touchTarget, eventType, 1.0, 1.0, edge)
    }

    /// Synchronously build + send a single touch. For use inside gesture blocks
    /// already running on `inputQueue`.
    @discardableResult
    private func rawSendTouch(type: String, x: Double, y: Double, edge: UInt32 = 0) -> Bool {
        guard let msg = touchMessage(type: type, x: x, y: y, edge: edge) else { return false }
        return rawSend(msg)
    }

    /// Returns whether the touch was handed to the HID client.
    func sendTouch(type: String, x: Double, y: Double, screenWidth: Int, screenHeight: Int, edge: UInt32 = 0) -> Bool {
        updateTouchTarget(width: screenWidth, height: screenHeight)
        guard let msg = touchMessage(type: type, x: x, y: y, edge: edge) else { return false }
        hidLog("[hid] Sending \(type) at (\(String(format:"%.3f",x)),\(String(format:"%.3f",y)))\(edge > 0 ? " edge=\(edge)" : "")")
        return rawSend(msg)
    }

    func sendMultiTouch(type: String, x1: Double, y1: Double, x2: Double, y2: Double, screenWidth: Int, screenHeight: Int) -> Bool {
        guard let mouseFunc = mouseFunc else { return false }

        let eventType: Int32
        switch type {
        case "begin", "move": eventType = 1
        case "end":           eventType = 2
        default: return false
        }

        updateTouchTarget(width: screenWidth, height: screenHeight)
        // Pass both CGPoints to create a 3-block multi-touch message.
        var point1 = CGPoint(x: x1, y: y1)
        var point2 = CGPoint(x: x2, y: y2)
        guard let rawMsg = mouseFunc(&point1, &point2, touchTarget, eventType, 1.0, 1.0, 0) else {
            print("[hid] IndigoHIDMessageForMouseNSEvent returned nil for multi-touch \(type)")
            return false
        }

        hidLog("[hid] Multi-touch \(type) f1=(\(String(format:"%.3f",x1)),\(String(format:"%.3f",y1))) f2=(\(String(format:"%.3f",x2)),\(String(format:"%.3f",y2)))")
        return rawSend(rawMsg)
    }

    // MARK: - Button events

    // idb eventSource constants (first arg to IndigoHIDMessageForButton)
    private static let buttonSourceHome: Int32 = 0x0
    private static let buttonSourceLock: Int32 = 0x1
    private static let buttonSourceSideButton: Int32 = 0xbb8
    private static let buttonSourceSiri: Int32 = 0x400002
    // Software-keyboard toggle — the event source Simulator.app's ⌘K sends.
    private static let buttonSourceSoftwareKeyboard: Int32 = 0x3f0

    // idb direction constants (second arg)
    private static let buttonDown: Int32 = 1
    private static let buttonUp: Int32 = 2

    // idb target constant (third arg)
    private static let buttonTargetHardware: Int32 = 0x33

    // Target for arbitrary (page, usage) HID — the digitizer, matching the touch
    // path that's honored on Xcode 26 (0x32).
    private static let buttonHIDTarget: UInt32 = 0x32

    /// Synchronously build + send a hardware-button message. Call only inside an
    /// `inputQueue` block (button sequences below run there).
    @discardableResult
    private func sendHIDButton(eventSource: Int32, direction: Int32) -> Bool {
        guard let buttonFunc = buttonFunc else { return false }
        guard let msg = buttonFunc(eventSource, direction, Self.buttonTargetHardware) else {
            print("[hid] IndigoHIDMessageForButton returned nil")
            return false
        }
        return rawSend(msg)
    }

    // MARK: - Keyboard events

    /// Inject a USB HID keyboard key event (Usage Page 0x07).
    /// - Parameters:
    ///   - type: "down" or "up"
    ///   - usage: HID usage code (e.g. 0x04 = 'A', 0x28 = Enter, 0xE1 = LeftShift)
    func sendKey(type: String, usage: UInt32) {
        let direction: UInt32
        switch type {
        case "down": direction = 1
        case "up":   direction = 2
        default: return
        }

        if deviceHubKeyboardBridge?.send(type: type, usage: usage) == true {
            hidLog("[hid] Posted Device Hub key \(type) usage=0x\(String(usage, radix: 16))")
            return
        }

        guard let keyboardFunc = keyboardFunc else {
            print("[hid] Keyboard injection unavailable")
            return
        }

        guard let msg = keyboardFunc(usage, direction) else {
            print("[hid] IndigoHIDMessageForKeyboardArbitrary returned nil (usage=0x\(String(usage, radix: 16)))")
            return
        }

        hidLog("[hid] Key \(type) usage=0x\(String(usage, radix: 16))")
        rawSend(msg)
    }

    // MARK: - Digital Crown events

    /// Inject a Digital Crown rotation event.
    /// - Parameter delta: Raw scroll delta, matching SimulatorKit's wheel-to-crown path.
    func sendDigitalCrown(delta: Double) {
        guard delta.isFinite, delta != 0 else { return }
        guard let digitalCrownFunc else {
            print("[hid] Digital Crown injection unavailable")
            return
        }

        guard let msg = digitalCrownFunc(delta) else {
            print("[hid] IndigoHIDMessageForDigitalCrownEvent returned nil (delta=\(delta))")
            return
        }

        hidLog("[hid] Digital Crown delta=\(String(format:"%.4f", delta))")
        rawSend(msg)
    }

    // MARK: - Scroll events
    //
    // iOS treats the simulator display as a touchscreen — there is no hardware
    // scroll wheel. Device Hub scrolls by capturing a real Mac trackpad and
    // forwarding genuine HID scroll events through a privileged pointer service
    // (`com.apple.private.hid.client.event-filter`); an unprivileged helper can't
    // capture host HID or synthesize events iOS accepts (synthetic scroll to the
    // pointer service 0x35 is silently dropped). See docs/scroll-injection-devicehub.md.
    //
    // So we scroll the way a finger does: translate the wheel delta into a touch
    // drag on the digitizer (target 0x32) — the same path taps/swipes use, which
    // is verified to scroll on iOS 27. A wheel burst becomes one continuous drag
    // (begin → moves → end on idle), re-anchoring to center when it nears an edge
    // so long scrolls aren't capped by the screen bounds.

    // Fraction of the display a finger travels per pixel of wheel delta. Wheel
    // deltas are large (~120/notch); 1.0 maps a notch to a full-screen drag, which
    // matches the feel of a wheel "page". Tunable.
    private static let scrollDragGain: Double = 1.0
    private static let scrollEdgeMargin: Double = 0.08   // re-anchor inside this margin
    private static let scrollGestureIdle: TimeInterval = 0.1

    private var scrollDragActive = false
    private var scrollFingerX = 0.5
    private var scrollFingerY = 0.5
    private var scrollAnchorX = 0.5   // where the gesture (re)starts — under the cursor
    private var scrollAnchorY = 0.5
    private var scrollEndWork: DispatchWorkItem?

    private func clampFinger(_ v: Double) -> Double {
        min(max(v, HIDInjector.scrollEdgeMargin), 1 - HIDInjector.scrollEdgeMargin)
    }

    /// Touch down to (re)start the scroll drag, then let iOS register the
    /// touch-down before the finger moves. Runs on `inputQueue`.
    private func beginDrag(x: Double, y: Double) {
        rawSendTouch(type: "begin", x: x, y: y)
        usleep(8000)
    }

    /// Inject a scroll-wheel / trackpad pan as a touch drag on the digitizer.
    /// - Parameters:
    ///   - dx: Horizontal scroll delta in device pixels (positive = content right).
    ///   - dy: Vertical scroll delta in device pixels (positive = content down).
    ///   - anchorX/anchorY: Normalized (0–1) cursor position to begin the drag
    ///     under, so iOS pans the view beneath the pointer. Nil = screen center.
    func sendScroll(dx: Double, dy: Double, anchorX: Double?, anchorY: Double?, screenWidth: Int, screenHeight: Int) async {
        guard dx.isFinite, dy.isFinite, (dx != 0 || dy != 0), screenWidth > 0, screenHeight > 0 else { return }

        updateTouchTarget(width: screenWidth, height: screenHeight)
        // Finger moves opposite to content: scrolling content down = swipe up.
        let stepX = -(dx / Double(screenWidth)) * HIDInjector.scrollDragGain
        let stepY = -(dy / Double(screenHeight)) * HIDInjector.scrollDragGain
        let aX = clampFinger(anchorX.flatMap { $0.isFinite ? $0 : nil } ?? 0.5)
        let aY = clampFinger(anchorY.flatMap { $0.isFinite ? $0 : nil } ?? 0.5)

        if !scrollDragActive {
            // Anchor a fresh gesture under the cursor so iOS hit-tests the
            // right scroll view (e.g. a bottom sheet vs. the map behind it).
            scrollAnchorX = aX
            scrollAnchorY = aY
            scrollFingerX = aX
            scrollFingerY = aY
            beginDrag(x: scrollFingerX, y: scrollFingerY)
            scrollDragActive = true
        }

        var nextX = scrollFingerX + stepX
        var nextY = scrollFingerY + stepY

        // Near an edge: lift, re-anchor back under the cursor, and continue.
        // Re-beginning at the anchor keeps the gesture hit-testing the same view.
        if nextX <= HIDInjector.scrollEdgeMargin || nextX >= 1 - HIDInjector.scrollEdgeMargin ||
            nextY <= HIDInjector.scrollEdgeMargin || nextY >= 1 - HIDInjector.scrollEdgeMargin {
            rawSendTouch(type: "end", x: scrollFingerX, y: scrollFingerY)
            scrollFingerX = scrollAnchorX
            scrollFingerY = scrollAnchorY
            beginDrag(x: scrollFingerX, y: scrollFingerY)
            nextX = scrollFingerX + stepX
            nextY = scrollFingerY + stepY
        }

        scrollFingerX = clampFinger(nextX)
        scrollFingerY = clampFinger(nextY)
        rawSendTouch(type: "move", x: scrollFingerX, y: scrollFingerY)

        // End the drag shortly after the wheel goes idle.
        scrollEndWork?.cancel()
        let work = DispatchWorkItem { [self] in
            guard scrollDragActive else { return }
            rawSendTouch(type: "end", x: scrollFingerX, y: scrollFingerY)
            scrollDragActive = false
        }
        scrollEndWork = work

        try? await Task.sleep(for: .seconds(HIDInjector.scrollGestureIdle))
        work.perform()
    }

    /// Press an arbitrary hardware button identified by its HID (page, usage),
    /// as shipped in DeviceKit chrome.json (`usagePage`/`usage`). Covers power,
    /// volume up/down, the action button, and the watch side button.
    /// - phase: "down" / "up" hold the button for natural long-presses (power
    ///   off slider, side-button menus); "press" sends a momentary down+up.
    /// Returns whether the press was handed to the guest.
    @discardableResult
    func sendButtonHID(page: UInt32, usage: UInt32, phase: String) async -> Bool {
        // Duo keys go through the guest helper, not `rawSend`.
        await channel.gated { await sendButtonHIDAdmitted(page: page, usage: usage, phase: phase) }
    }

    private func sendButtonHIDAdmitted(page: UInt32, usage: UInt32, phase: String) async -> Bool {
        if let duoBridge {
            switch phase {
            case "down": return duoBridge.send("key \(page) \(usage) 1")
            case "up": return duoBridge.send("key \(page) \(usage) 0")
            case "press":
                guard duoBridge.send("key \(page) \(usage) 1") else { return false }
                try? await Task.sleep(for: .milliseconds(250))
                return duoBridge.send("key \(page) \(usage) 0")
            default: return false
            }
        }
        guard let arb = hidArbitraryFunc else {
            print("[hid] Arbitrary HID injection unavailable (page=\(page) usage=\(usage))")
            return false
        }
        let target = Self.buttonHIDTarget
        func emit(_ direction: UInt32) -> Bool {
            guard let msg = arb(target, page, usage, direction) else {
                print("[hid] IndigoHIDMessageForHIDArbitrary returned nil (page=\(page) usage=\(usage) dir=\(direction))")
                return false
            }
            return rawSend(msg)
        }
        hidLog("[hid] HID button page=\(page) usage=\(usage) phase=\(phase)")
        switch phase {
        case "down": return emit(1)
        case "up":   return emit(2)
        default:
            guard emit(1) else { return false }
            try? await Task.sleep(for: .seconds(0.05))
            return emit(2)
        }
    }

    /// Returns whether the button was handed to the guest (false for an
    /// unknown button or when the HID client / message builder is missing).
    func sendButton(button: String, deviceUDID: String) async -> Bool {
        hidLog("[hid] Sending button: \(button)")
        // Home relaunches SpringBoard and Duo buttons go through the guest
        // helper, neither via `rawSend`, so gate the whole press.
        return await channel.gated { await sendButtonAdmitted(button: button, deviceUDID: deviceUDID) }
    }

    private func sendButtonAdmitted(button: String, deviceUDID: String) async -> Bool {
        switch button {
        case "home":
            // Xcode 26+ silently drops the Indigo HID home-button press, so the
            // press is delivered but never reaches SpringBoard. Relaunching
            // SpringBoard leaves a foreground app on every Xcode version (it's
            // what the buttonFunc-missing fallback always used). It is a no-op
            // when SpringBoard is already frontmost (App Library, folders,
            // inner home pages); NativeHid routes those to flick_home.
            await launchSpringBoard(deviceUDID: deviceUDID)
            return true

        case "flick_home":
            // Short home-indicator flick. Long swipe_home (yEnd 0.35) can open
            // the app switcher when already on the first home page.
            return sendSwipeHome(yEnd: 0.70)

        case "swipe_home":
            return sendSwipeHome()

        case "app_switcher":
            if buttonFunc != nil {
                // Double home press with delay for app switcher
                guard sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonDown) else { return false }
                sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonUp)
                try? await Task.sleep(for: .seconds(0.15))
                sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonDown)
                return sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonUp)
            } else {
                print("[hid] App switcher not available (IndigoHIDMessageForButton not loaded)")
                return false
            }

        case "lock":
            if duoBridge != nil {
                return await sendButtonHID(page: 0x0c, usage: 0x30, phase: "press")
            }
            guard sendHIDButton(eventSource: Self.buttonSourceLock, direction: Self.buttonDown) else { return false }
            return sendHIDButton(eventSource: Self.buttonSourceLock, direction: Self.buttonUp)

        case "siri":
            // Holding Siri for ~300ms matches Simulator.app's "hold side button
            // to invoke Siri" gesture; a tap is ignored.
            guard sendHIDButton(eventSource: Self.buttonSourceSiri, direction: Self.buttonDown) else { return false }
            try? await Task.sleep(for: .seconds(0.3))
            return sendHIDButton(eventSource: Self.buttonSourceSiri, direction: Self.buttonUp)

        case "side_button":
            guard sendHIDButton(eventSource: Self.buttonSourceSideButton, direction: Self.buttonDown) else { return false }
            return sendHIDButton(eventSource: Self.buttonSourceSideButton, direction: Self.buttonUp)

        default:
            print("[hid] Unknown button: \(button)")
            return false
        }
    }

    // MARK: - SimDevice private control

    /// Toggle a CoreAnimation render debug flag on the simulator. Names are the
    /// strings Simulator.app's Debug menu passes to `-[SimDevice
    /// setCADebugOption:enabled:]` (CoreSimulator private category):
    ///   debug_color_blended / debug_color_copies / debug_color_misaligned
    ///   debug_color_offscreen / debug_slow_animations
    func setCADebugOption(name: String, enabled: Bool) -> Bool {
        guard let device = simDevice else {
            fputs("[sim] setCADebugOption: no SimDevice\n", stderr)
            return false
        }
        let sel = NSSelectorFromString("setCADebugOption:enabled:")
        guard device.responds(to: sel) else {
            fputs("[sim] setCADebugOption: selector not available on SimDevice\n", stderr)
            return false
        }
        typealias Fn = @convention(c) (AnyObject, Selector, NSString, ObjCBool) -> ObjCBool
        let imp = device.method(for: sel)
        let fn = unsafeBitCast(imp, to: Fn.self)
        let result = fn(device, sel, name as NSString, ObjCBool(enabled))
        hidLog("[sim] setCADebugOption(\(name), \(enabled)) → \(result.boolValue)")
        return result.boolValue
    }

    /// Connect or disconnect the simulated hardware keyboard, exactly like
    /// Simulator.app's I/O → Keyboard → Connect Hardware Keyboard and Device
    /// Hub's Simulate Hardware Keyboard (⇧⌘K). Calls `-[SimDevice
    /// setHardwareKeyboardEnabled:keyboardType:error:]` (CoreSimulator
    /// private). Disconnected (NO) lets the software keyboard appear for a
    /// focused field; connected (YES) hides it. There is no getter, so callers
    /// track the state themselves. Connecting sends NO, waits, then YES: a
    /// YES that doesn't change CoreSimulator's state is a no-op, and the guest
    /// coalesces a NO/YES pair sent back to back (measured: 0 ms no effect,
    /// 250 ms reliable on iOS 27.2).
    func setHardwareKeyboard(enabled: Bool) async -> Bool {
        guard let device = simDevice else {
            fputs("[sim] setHardwareKeyboard: no SimDevice\n", stderr)
            return false
        }
        let sel = NSSelectorFromString("setHardwareKeyboardEnabled:keyboardType:error:")
        guard device.responds(to: sel) else {
            fputs("[sim] setHardwareKeyboard: selector not available on SimDevice\n", stderr)
            return false
        }
        if enabled {
            // A failed NO must not be followed by a "successful" YES, or
            // DeviceSession would persist a connected state the guest never reached.
            guard callSetHardwareKeyboard(device, sel, enabled: false) else { return false }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return callSetHardwareKeyboard(device, sel, enabled: enabled)
    }

    private func callSetHardwareKeyboard(_ device: NSObject, _ sel: Selector, enabled: Bool) -> Bool {
        typealias Fn = @convention(c) (AnyObject, Selector, ObjCBool, UInt8, AutoreleasingUnsafeMutablePointer<NSError?>?) -> ObjCBool
        let imp = device.method(for: sel)
        let fn = unsafeBitCast(imp, to: Fn.self)
        var error: NSError?
        let result = fn(device, sel, ObjCBool(enabled), 0, &error)
        hidLog("[sim] setHardwareKeyboard(\(enabled)) → \(result.boolValue)")
        if !result.boolValue {
            fputs("[sim] setHardwareKeyboard(\(enabled)) failed: \(error?.localizedDescription ?? "unknown error")\n", stderr)
        }
        return result.boolValue
    }

    // MARK: - Fold pose / hinge

    func isFoldable() -> Bool { duoBridge != nil }

    func setDuoHelper(_ path: String) { duoBridge?.executable = path }

    func close() {
        unregisterStateNotifications()
        duoBridge = nil
    }

    private func updateTouchTarget(width: Int, height: Int) {
        guard duoBridge != nil else { return }
        if let target = DevicePose.touchTarget(width: width, height: height) { touchTarget = target }
    }

    func setPose(_ name: String, fromDegrees: Double) -> Bool {
        guard let pose = DevicePose.preset(named: name), fromDegrees.isFinite,
              (0...180).contains(fromDegrees) else { return false }
        // Gated like other input: a dead device would only fail later, in the guest helper's spawn.
        guard channel.admit() else { return false }
        return duoBridge?.send("sweep \(fromDegrees) \(pose.hingeDegrees) 800") == true
    }

    func setHingeAngle(degrees: Double) -> Bool {
        guard degrees.isFinite, (0...180).contains(degrees) else { return false }
        guard channel.admit() else { return false }
        return duoBridge?.send("angle \(degrees)") == true
    }

    /// Toggle the on-screen software keyboard, exactly like Simulator.app's
    /// I/O → Keyboard → Toggle Software Keyboard (⌘K): a momentary Indigo HID
    /// button press (event source 0x3f0) sent through the legacy HID client.
    /// Instant, and leaves the hardware-keyboard state untouched.
    func toggleSoftwareKeyboard() {
        guard buttonFunc != nil else {
            print("[hid] Software keyboard toggle unavailable (IndigoHIDMessageForButton not loaded)")
            return
        }
        sendHIDButton(eventSource: Self.buttonSourceSoftwareKeyboard, direction: Self.buttonDown)
        sendHIDButton(eventSource: Self.buttonSourceSoftwareKeyboard, direction: Self.buttonUp)
    }

    /// Ask CoreSimulator to broadcast a memory warning to the simulated OS.
    /// Equivalent to Debug → Simulate Memory Warning and idb's
    /// FBSimulatorMemoryCommands.simulateMemoryWarning.
    func simulateMemoryWarning() {
        guard let device = simDevice else {
            fputs("[sim] simulateMemoryWarning: no SimDevice\n", stderr)
            return
        }
        let sel = NSSelectorFromString("simulateMemoryWarning")
        guard device.responds(to: sel) else {
            fputs("[sim] simulateMemoryWarning: selector not available on SimDevice\n", stderr)
            return
        }
        _ = device.perform(sel)
        hidLog("[sim] simulateMemoryWarning dispatched")
    }

    /// Synthesize a swipe-up-from-bottom gesture (Face ID "go home" gesture).
    /// Uses IndigoHIDEdge.bottom to flag touches as system edge gestures,
    /// which iOS interprets as the home indicator swipe.
    ///
    /// Default `yEnd` 0.35 is a long swipe (legacy `swipe_home`). A shorter
    /// flick (`yEnd` 0.70) leaves apps, dismisses App Library and folders, and
    /// returns to page 1, without opening the app switcher on page 1.
    private func sendSwipeHome(yEnd: Double = 0.35) -> Bool {
        let xPos = 0.5
        let yStart = 0.95
        let steps = 10
        let stepDelay: TimeInterval = 0.016  // ~16ms per step
        let edge = Self.edgeBottom

        // Touch down at bottom edge
        guard rawSendTouch(type: "begin", x: xPos, y: yStart, edge: edge) else { return false }
        Thread.sleep(forTimeInterval: stepDelay)

        // Interpolated moves upward
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let y = yStart + (yEnd - yStart) * t
            rawSendTouch(type: "move", x: xPos, y: y, edge: edge)
            Thread.sleep(forTimeInterval: stepDelay)
        }

        // Touch up
        return rawSendTouch(type: "end", x: xPos, y: yEnd, edge: edge)
    }

    /// Launches SpringBoard off the actor, falling back to `simctl`, and returns
    /// once the attempt finishes.
    private func launchSpringBoard(deviceUDID: String) async {
        let device = simDevice.map(UncheckedSimDevice.init)
        await springBoardLauncher.launch(
            direct: { Self.launchSpringBoardDirectly(device: device?.device) },
            fallback: {
                // Older CoreSimulator versions may not expose the direct launch API.
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
                process.arguments = DeviceSet.simctlArguments(["launch", deviceUDID, "com.apple.springboard"])
                // Already on the launcher's queue; waiting keeps repeat presses
                // coalesced instead of starting overlapping simctl processes.
                SpringBoardLauncher.runToExit(process, timeout: 30)
            }
        )
    }

    /// Blocks until CoreSimulator answers, so it must stay off the actor's executor.
    private nonisolated static func launchSpringBoardDirectly(device: NSObject?) -> SpringBoardLauncher.DirectResult {
        let sel = NSSelectorFromString("launchApplicationWithID:options:pid:error:")
        guard let device, device.responds(to: sel) else { return .unavailable }
        typealias Fn = @convention(c) (
            AnyObject, Selector, NSString, NSDictionary,
            UnsafeMutablePointer<pid_t>, AutoreleasingUnsafeMutablePointer<NSError?>
        ) -> ObjCBool
        let fn = unsafeBitCast(device.method(for: sel), to: Fn.self)
        var pid: pid_t = 0
        var error: NSError?
        if fn(device, sel, "com.apple.springboard", [:], &pid, &error).boolValue { return .launched }
        return .failed(error?.localizedDescription ?? "unknown error")
    }

    // MARK: - Orientation (GSEvent via PurpleWorkspacePort)

    // UIDeviceOrientation values accepted by the guest's GraphicsServices.
    static let orientationPortrait: UInt32 = 1
    static let orientationPortraitUpsideDown: UInt32 = 2
    static let orientationLandscapeRight: UInt32 = 3
    static let orientationLandscapeLeft: UInt32 = 4

    // GSEvent wire-format constants. Reverse-engineered by idb from
    // Simulator.app's ARM64 disassembly; see idb's SimulatorApp/GSEvent.h.
    private static let gsEventTypeDeviceOrientationChanged: UInt32 = 50
    private static let gsEventHostFlag: UInt32 = 0x20000
    private static let gsEventMachMessageID: mach_msg_id_t = 0x7B

    /// Send a device-orientation GSEvent to the simulator.
    ///
    /// GSEvent messages travel a different path from Indigo HID: they go
    /// through `mach_msg_send` → `PurpleWorkspacePort` →
    /// `GraphicsServices._PurpleEventCallback` → backboardd. This is how
    /// Simulator.app itself rotates the device, and how idb's
    /// `FBSimulatorPurpleHID.orientationEvent:` is delivered.
    func sendOrientation(orientation: UInt32) -> Bool {
        // A shut-down device would otherwise fail later (PurpleWorkspacePort
        // lookup / the Duo helper's spawn). The gate fails fast and with the same log line.
        guard channel.admit() else { return false }
        if let duoBridge {
            guard (1...4).contains(orientation) else { return false }
            return duoBridge.send("orientation \(orientation)")
        }
        guard let device = simDevice else {
            fputs("[hid] sendOrientation: no SimDevice (setup not called?)\n", stderr)
            return false
        }

        let lookupSel = NSSelectorFromString("lookup:error:")
        typealias LookupFunc = @convention(c) (
            AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>
        ) -> mach_port_t
        guard let lookupIMP = class_getMethodImplementation(object_getClass(device)!, lookupSel) else {
            fputs("[hid] sendOrientation: -[SimDevice lookup:error:] not found\n", stderr)
            return false
        }
        let lookup = unsafeBitCast(lookupIMP, to: LookupFunc.self)

        var lookupError: NSError?
        let purplePort = lookup(device, lookupSel, "PurpleWorkspacePort" as NSString, &lookupError)
        if purplePort == 0 {
            fputs("[hid] sendOrientation: PurpleWorkspacePort not found (\(lookupError?.localizedDescription ?? "no error")). Simulator.app must be running.\n", stderr)
            return false
        }

        // 112-byte aligned buffer (>= 108 = align4(4 + 0x6B), the msgh_size
        // for a GSEvent with a 4-byte orientation payload).
        var buf = [UInt8](repeating: 0, count: 112)
        return buf.withUnsafeMutableBufferPointer { ptr in
            let base = UnsafeMutableRawPointer(ptr.baseAddress!)
            let header = base.assumingMemoryBound(to: mach_msg_header_t.self)
            header.pointee.msgh_bits = mach_msg_bits_t(MACH_MSG_TYPE_COPY_SEND)
            header.pointee.msgh_size = 108
            header.pointee.msgh_remote_port = purplePort
            header.pointee.msgh_local_port = mach_port_t(MACH_PORT_NULL)
            header.pointee.msgh_voucher_port = mach_port_t(MACH_PORT_NULL)
            header.pointee.msgh_id = Self.gsEventMachMessageID

            // GSEvent type at offset 0x18 — record_info_size at 0x48 — payload at 0x4C.
            base.storeBytes(
                of: Self.gsEventTypeDeviceOrientationChanged | Self.gsEventHostFlag,
                toByteOffset: 0x18, as: UInt32.self)
            base.storeBytes(of: UInt32(4), toByteOffset: 0x48, as: UInt32.self)
            base.storeBytes(of: orientation, toByteOffset: 0x4C, as: UInt32.self)

            let kr = mach_msg_send(header)
            if kr != KERN_SUCCESS {
                fputs("[hid] sendOrientation: mach_msg_send failed (\(kr))\n", stderr)
                return false
            } else {
                hidLog("[hid] Orientation set to \(orientation)")
                return true
            }
        }
    }
}
