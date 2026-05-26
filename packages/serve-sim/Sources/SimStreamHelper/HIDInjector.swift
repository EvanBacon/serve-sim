import Foundation
import ObjectiveC
import Darwin

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
final class HIDInjector {
    private var hidClient: NSObject?
    private var sendSel: Selector?
    private var simDevice: NSObject?

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

    // IndigoHIDMessageForKeyboardArbitrary(uint32_t keyCode, uint32_t direction) -> IndigoMessage*
    // direction: 1 = key down, 2 = key up
    private typealias IndigoKeyboardFunc = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?
    private var keyboardFunc: IndigoKeyboardFunc?

    // IndigoHIDMessageForDigitalCrownEvent(double rotationalDelta) -> IndigoMessage*
    private typealias IndigoDigitalCrownFunc = @convention(c) (Double) -> UnsafeMutableRawPointer?
    private var digitalCrownFunc: IndigoDigitalCrownFunc?

    // IndigoHIDMessageForHIDArbitrary(int target, uint32_t usagePage, uint32_t usage, uint32_t direction) -> IndigoMessage*
    // direction: 1 = down, 2 = up
    private typealias IndigoHIDArbitraryFunc = @convention(c) (Int32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
    private var hidArbitraryFunc: IndigoHIDArbitraryFunc?

    func setup(deviceUDID: String) throws {
        _ = dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)
        _ = dlopen("/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW)

        guard let device = FrameCapture.findSimDevice(udid: deviceUDID) else {
            throw NSError(domain: "HIDInjector", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Device \(deviceUDID) not found"])
        }
        self.simDevice = device

        guard let funcPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForMouseNSEvent") else {
            throw NSError(domain: "HIDInjector", code: 5,
                          userInfo: [NSLocalizedDescriptionKey: "IndigoHIDMessageForMouseNSEvent not found"])
        }
        self.mouseFunc = unsafeBitCast(funcPtr, to: IndigoMouseFunc.self)

        if let buttonPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForButton") {
            self.buttonFunc = unsafeBitCast(buttonPtr, to: IndigoButtonFunc.self)
            print("[hid] IndigoHIDMessageForButton loaded")
        } else {
            print("[hid] Warning: IndigoHIDMessageForButton not found")
        }

        if let keyboardPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForKeyboardArbitrary") {
            self.keyboardFunc = unsafeBitCast(keyboardPtr, to: IndigoKeyboardFunc.self)
            print("[hid] IndigoHIDMessageForKeyboardArbitrary loaded")
        } else {
            print("[hid] Warning: IndigoHIDMessageForKeyboardArbitrary not found")
        }

        if let crownPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForDigitalCrownEvent") {
            self.digitalCrownFunc = unsafeBitCast(crownPtr, to: IndigoDigitalCrownFunc.self)
            print("[hid] IndigoHIDMessageForDigitalCrownEvent loaded")
        } else {
            print("[hid] Warning: IndigoHIDMessageForDigitalCrownEvent not found")
        }

        if let arbPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForHIDArbitrary") {
            self.hidArbitraryFunc = unsafeBitCast(arbPtr, to: IndigoHIDArbitraryFunc.self)
            print("[hid] IndigoHIDMessageForHIDArbitrary loaded")
        } else {
            print("[hid] Warning: IndigoHIDMessageForHIDArbitrary not found")
        }

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

        self.hidClient = clientObj
        self.sendSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        print("[hid] SimDeviceLegacyHIDClient created")
        print("[hid] IndigoHIDMessageForMouseNSEvent loaded (with edge gesture support)")

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

    func sendTouch(type: String, x: Double, y: Double, screenWidth: Int, screenHeight: Int, edge: UInt32 = 0) {
        guard let client = hidClient, let sendSel = sendSel, let mouseFunc = mouseFunc else { return }

        // x, y are normalized 0..1
        var point = CGPoint(x: x, y: y)

        let eventType: Int32
        switch type {
        case "begin": eventType = 1  // NSEventTypeLeftMouseDown
        case "move":  eventType = 1  // Continued touch — use Down, not Dragged (C function rejects 6)
        case "end":   eventType = 2  // NSEventTypeLeftMouseUp
        default: return
        }

        // Pass NSSize(1.0, 1.0) so ratio = point / 1.0 = point (no manual patching needed).
        guard let rawMsg = mouseFunc(&point, nil, 0x32, eventType, 1.0, 1.0, edge) else {
            print("[hid] IndigoHIDMessageForMouseNSEvent returned nil for \(type)")
            return
        }

        print("[hid] Sending \(type) at (\(String(format:"%.3f",x)),\(String(format:"%.3f",y)))\(edge > 0 ? " edge=\(edge)" : "")")

        typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
        guard let sendIMP = class_getMethodImplementation(object_getClass(client)!, sendSel) else {
            free(rawMsg)
            return
        }
        let sendFunc = unsafeBitCast(sendIMP, to: SendFunc.self)
        sendFunc(client, sendSel, rawMsg, ObjCBool(true), nil, nil)
    }

    func sendMultiTouch(type: String, x1: Double, y1: Double, x2: Double, y2: Double, screenWidth: Int, screenHeight: Int) {
        guard let client = hidClient, let sendSel = sendSel, let mouseFunc = mouseFunc else { return }

        let eventType: Int32
        switch type {
        case "begin": eventType = 1  // NSEventTypeLeftMouseDown
        case "move":  eventType = 1  // Continued touch — use Down, not Dragged (C function rejects 6)
        case "end":   eventType = 2  // NSEventTypeLeftMouseUp
        default: return
        }

        // Pass both CGPoints to create a 3-block multi-touch message.
        // NSSize(1.0, 1.0) makes ratio = point / 1.0 = point, so all fields
        // (ratios + any derived values) are computed correctly by the C function.
        var point1 = CGPoint(x: x1, y: y1)
        var point2 = CGPoint(x: x2, y: y2)

        guard let rawMsg = mouseFunc(&point1, &point2, 0x32, eventType, 1.0, 1.0, 0) else {
            print("[hid] IndigoHIDMessageForMouseNSEvent returned nil for multi-touch \(type)")
            return
        }

        print("[hid] Multi-touch \(type) f1=(\(String(format:"%.3f",x1)),\(String(format:"%.3f",y1))) f2=(\(String(format:"%.3f",x2)),\(String(format:"%.3f",y2)))")

        typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
        guard let sendIMP = class_getMethodImplementation(object_getClass(client)!, sendSel) else {
            free(rawMsg)
            return
        }
        let sendFunc = unsafeBitCast(sendIMP, to: SendFunc.self)
        sendFunc(client, sendSel, rawMsg, ObjCBool(true), nil, nil)
    }

    // MARK: - Button events

    // idb eventSource constants (first arg to IndigoHIDMessageForButton)
    private static let buttonSourceHome: Int32 = 0x0
    private static let buttonSourceLock: Int32 = 0x1
    private static let buttonSourceSideButton: Int32 = 0xbb8
    private static let buttonSourceSiri: Int32 = 0x400002

    // idb direction constants (second arg)
    private static let buttonDown: Int32 = 1
    private static let buttonUp: Int32 = 2

    // idb target constant (third arg)
    private static let buttonTargetHardware: Int32 = 0x33

    private func sendHIDButton(eventSource: Int32, direction: Int32, target: Int32 = buttonTargetHardware) {
        guard let client = hidClient, let sendSel = sendSel, let buttonFunc = buttonFunc else { return }

        // IndigoHIDMessageForButton returns a ready-to-send message
        // idb uses it directly with malloc_size to determine length
        guard let msg = buttonFunc(eventSource, direction, target) else {
            print("[hid] IndigoHIDMessageForButton returned nil")
            return
        }

        // Send via SimDeviceLegacyHIDClient (freeWhenDone: true — runtime will free msg)
        typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
        guard let sendIMP = class_getMethodImplementation(object_getClass(client)!, sendSel) else {
            free(msg)
            return
        }
        let sendFunc = unsafeBitCast(sendIMP, to: SendFunc.self)
        sendFunc(client, sendSel, msg, ObjCBool(true), nil, nil)
    }

    private let buttonQueue = DispatchQueue(label: "hid-button")

    // MARK: - Keyboard events

    /// Inject a USB HID keyboard key event (Usage Page 0x07).
    /// - Parameters:
    ///   - type: "down" or "up"
    ///   - usage: HID usage code (e.g. 0x04 = 'A', 0x28 = Enter, 0xE1 = LeftShift)
    func sendKey(type: String, usage: UInt32) {
        guard let client = hidClient, let sendSel = sendSel, let keyboardFunc = keyboardFunc else {
            print("[hid] Keyboard injection unavailable")
            return
        }

        let direction: UInt32
        switch type {
        case "down": direction = 1
        case "up":   direction = 2
        default: return
        }

        guard let msg = keyboardFunc(usage, direction) else {
            print("[hid] IndigoHIDMessageForKeyboardArbitrary returned nil (usage=0x\(String(usage, radix: 16)))")
            return
        }

        print("[hid] Key \(type) usage=0x\(String(usage, radix: 16))")

        typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
        guard let sendIMP = class_getMethodImplementation(object_getClass(client)!, sendSel) else {
            free(msg)
            return
        }
        let sendFunc = unsafeBitCast(sendIMP, to: SendFunc.self)
        sendFunc(client, sendSel, msg, ObjCBool(true), nil, nil)
    }

    // MARK: - Digital Crown events

    /// Inject a Digital Crown rotation event.
    /// - Parameter delta: Raw scroll delta, matching SimulatorKit's wheel-to-crown path.
    func sendDigitalCrown(delta: Double) {
        guard delta.isFinite, delta != 0 else { return }
        guard let client = hidClient, let sendSel = sendSel else {
            print("[hid] Digital Crown injection unavailable")
            return
        }

        guard let digitalCrownFunc else {
            print("[hid] Digital Crown injection unavailable")
            return
        }

        let msg = digitalCrownFunc(delta)
        guard let msg else {
            print("[hid] IndigoHIDMessageForDigitalCrownEvent returned nil (delta=\(delta))")
            return
        }

        print("[hid] Digital Crown delta=\(String(format:"%.4f", delta))")

        typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
        guard let sendIMP = class_getMethodImplementation(object_getClass(client)!, sendSel) else {
            free(msg)
            return
        }
        let sendFunc = unsafeBitCast(sendIMP, to: SendFunc.self)
        sendFunc(client, sendSel, msg, ObjCBool(true), nil, nil)
    }

    /// Dispatch a hardware-button or Siri-remote button press by name.
    /// - Parameters:
    ///   - button: The button identifier — iOS values like `home`, `lock`,
    ///     `siri`, `side_button`, or tvOS Siri-remote values like
    ///     `remote_up` / `remote_select` / `remote_play_pause` / `remote_tv`
    ///     etc. Unknown names are logged and ignored.
    ///   - deviceUDID: The simulator UDID — only used for the `home` SpringBoard
    ///     fallback when the HID symbol isn't resolvable.
    ///   - holdMs: Optional press duration in milliseconds. Honored only for
    ///     buttons with a discrete long-press gesture on tvOS
    ///     (`remote_select`, `remote_play_pause`, `remote_menu`); every other
    ///     button silently ignores this. When set, the press is held on
    ///     `buttonQueue` so the caller's thread isn't blocked.
    func sendButton(button: String, deviceUDID: String, holdMs: UInt32? = nil) {
        if let holdMs {
            print("[hid] Sending button: \(button) (hold \(holdMs)ms)")
        } else {
            print("[hid] Sending button: \(button)")
        }

        switch button {
        case "home":
            if buttonFunc != nil {
                // Single home press via HID
                sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonDown)
                sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonUp)
            } else {
                // Fallback: simctl
                launchSpringBoard(deviceUDID: deviceUDID)
            }

        case "swipe_home":
            buttonQueue.async { [self] in
                sendSwipeHome()
            }

        case "app_switcher":
            if buttonFunc != nil {
                // Double home press with delay for app switcher
                buttonQueue.async { [self] in
                    sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonDown)
                    sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonUp)
                    Thread.sleep(forTimeInterval: 0.15)
                    sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonDown)
                    sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonUp)
                }
            } else {
                print("[hid] App switcher not available (IndigoHIDMessageForButton not loaded)")
            }

        case "lock":
            sendHIDButton(eventSource: Self.buttonSourceLock, direction: Self.buttonDown)
            sendHIDButton(eventSource: Self.buttonSourceLock, direction: Self.buttonUp)

        case "siri":
            // Holding Siri for ~300ms matches Simulator.app's "hold side button
            // to invoke Siri" gesture; a tap is ignored.
            buttonQueue.async { [self] in
                sendHIDButton(eventSource: Self.buttonSourceSiri, direction: Self.buttonDown)
                Thread.sleep(forTimeInterval: 0.3)
                sendHIDButton(eventSource: Self.buttonSourceSiri, direction: Self.buttonUp)
            }

        case "side_button":
            sendHIDButton(eventSource: Self.buttonSourceSideButton, direction: Self.buttonDown)
            sendHIDButton(eventSource: Self.buttonSourceSideButton, direction: Self.buttonUp)

        // Apple TV / Siri remote. Directional keys ride the keyboard HID
        // path (which tvOS's focus engine listens to); the discrete remote
        // buttons (TV/menu/play-pause/volume/siri) go through
        // IndigoHIDMessageForButton on the remote target.
        case "remote_up":          pressKey(usage: 0x52)
        case "remote_down":        pressKey(usage: 0x51)
        case "remote_left":        pressKey(usage: 0x50)
        case "remote_right":       pressKey(usage: 0x4F)
        case "remote_select":      pressKey(usage: 0x28, holdMs: holdMs) // Return
        case "remote_menu":        pressConsumer(usage: 0x46, holdMs: holdMs) // Menu Escape
        case "remote_tv":          pressConsumer(usage: 0x223) // AC Home
        case "remote_play_pause":  pressConsumer(usage: 0xCD, holdMs: holdMs) // Play/Pause
        case "remote_volume_up":   pressConsumer(usage: 0xE9) // Volume Increment
        case "remote_volume_down": pressConsumer(usage: 0xEA) // Volume Decrement
        case "remote_siri":        pressConsumer(usage: 0xCF) // Voice Command

        default:
            print("[hid] Unknown button: \(button)")
        }
    }

    /// Press-and-release helper for the keyboard HID path. Used by Siri remote
    /// mappings — a single sendButton call yields a complete keystroke. When
    /// `holdMs` is provided, the press is held on the buttonQueue so the
    /// caller's thread isn't blocked.
    private func pressKey(usage: UInt32, holdMs: UInt32? = nil) {
        if let holdMs {
            buttonQueue.async { [self] in
                sendKey(type: "down", usage: usage)
                Thread.sleep(forTimeInterval: Double(holdMs) / 1000.0)
                sendKey(type: "up", usage: usage)
            }
        } else {
            sendKey(type: "down", usage: usage)
            sendKey(type: "up", usage: usage)
        }
    }

    /// Send a USB HID Consumer/Generic event (e.g. media keys like Play/Pause)
    /// via IndigoHIDMessageForHIDArbitrary — the route Simulator.app uses to
    /// translate Mac media keys into simulator events. `direction` is 1 for
    /// press, 2 for release.
    private func sendHIDArbitrary(target: Int32, usagePage: UInt32, usage: UInt32, direction: UInt32) {
        guard let client = hidClient, let sendSel = sendSel, let arbFunc = hidArbitraryFunc else {
            print("[hid] IndigoHIDMessageForHIDArbitrary unavailable")
            return
        }
        guard let msg = arbFunc(target, usagePage, usage, direction) else {
            print("[hid] IndigoHIDMessageForHIDArbitrary returned nil (page=0x\(String(usagePage, radix: 16)) usage=0x\(String(usage, radix: 16)) dir=\(direction))")
            return
        }
        typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
        guard let sendIMP = class_getMethodImplementation(object_getClass(client)!, sendSel) else {
            free(msg)
            return
        }
        let sendFunc = unsafeBitCast(sendIMP, to: SendFunc.self)
        sendFunc(client, sendSel, msg, ObjCBool(true), nil, nil)
    }

    /// HID target that routes Consumer-page events to the tvOS Siri-remote
    /// subsystem (distinct from the iOS hardware-button target 0x33).
    private static let consumerTarget: Int32 = 0x15

    /// Press-and-release a USB HID Consumer-page key (media keys, AC controls)
    /// — the transport for the discrete Siri-remote buttons. When `holdMs` is
    /// provided the press is held on `buttonQueue` for that long before
    /// releasing, so the caller's thread isn't blocked.
    private func pressConsumer(usage: UInt32, holdMs: UInt32? = nil) {
        if let holdMs {
            buttonQueue.async { [self] in
                sendHIDArbitrary(target: Self.consumerTarget, usagePage: 0x0C, usage: usage, direction: 1)
                Thread.sleep(forTimeInterval: Double(holdMs) / 1000.0)
                sendHIDArbitrary(target: Self.consumerTarget, usagePage: 0x0C, usage: usage, direction: 2)
            }
        } else {
            sendHIDArbitrary(target: Self.consumerTarget, usagePage: 0x0C, usage: usage, direction: 1)
            sendHIDArbitrary(target: Self.consumerTarget, usagePage: 0x0C, usage: usage, direction: 2)
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
        print("[sim] setCADebugOption(\(name), \(enabled)) → \(result.boolValue)")
        return result.boolValue
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
        print("[sim] simulateMemoryWarning dispatched")
    }

    /// Synthesize a swipe-up-from-bottom gesture (Face ID "go home" gesture).
    /// Uses IndigoHIDEdge.bottom to flag touches as system edge gestures,
    /// which iOS interprets as the home indicator swipe.
    private func sendSwipeHome() {
        let xPos = 0.5
        let yStart = 0.95
        let yEnd = 0.35
        let steps = 10
        let stepDelay: TimeInterval = 0.016  // ~16ms per step
        let edge = Self.edgeBottom

        // Touch down at bottom edge
        sendTouch(type: "begin", x: xPos, y: yStart, screenWidth: 0, screenHeight: 0, edge: edge)
        Thread.sleep(forTimeInterval: stepDelay)

        // Interpolated moves upward
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let y = yStart + (yEnd - yStart) * t
            sendTouch(type: "move", x: xPos, y: y, screenWidth: 0, screenHeight: 0, edge: edge)
            Thread.sleep(forTimeInterval: stepDelay)
        }

        // Touch up
        sendTouch(type: "end", x: xPos, y: yEnd, screenWidth: 0, screenHeight: 0, edge: edge)
    }

    private func launchSpringBoard(deviceUDID: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["simctl", "launch", deviceUDID, "com.apple.springboard"]
        try? process.run()
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
                print("[hid] Orientation set to \(orientation)")
                return true
            }
        }
    }
}
