import Foundation
import NodeAPI

/// Safe Int→UInt32 for HID codes coming from JS. Plain `UInt32(x)` traps on
/// negative or too-large values, which would crash the in-process server on
/// malformed input; clamp out-of-range values to 0 (a harmless no-op code).
private func u32(_ v: Int) -> UInt32 {
    UInt32(exactly: v) ?? 0
}

// node-swift entrypoint for serve-sim-native — the in-process N-API addon that
// replaces the spawned serve-sim-bin helper. The JS surface is expressed
// directly in Swift (no Objective-C++ glue): HID and frame capture are
// NodeClasses, and the accessibility dumps are async NodeFunctions. The
// reverse-engineered logic (HIDInjector, the CaptureEngine + encoders,
// AccessibilityBridge) is reused verbatim from SimStreamHelper.

// MARK: - HID

/// In-process HID injector for one simulator. Mirrors the WebSocket HID protocol
/// the spawned helper used to handle, as direct native calls. The instance is
/// released (freeing the injector) when its JS handle is garbage-collected.
@NodeClass @NodeActor final class SimHID {
    private let injector: HIDInjector
    private let udid: String

    @NodeConstructor init(_ udid: String) throws {
        self.udid = udid
        injector = HIDInjector()
        try injector.setup(deviceUDID: udid)
    }

    @NodeMethod func touch(_ type: String, _ x: Double, _ y: Double,
                           _ w: Int, _ h: Int, _ edge: Int) {
        injector.sendTouch(type: type, x: x, y: y,
                           screenWidth: w, screenHeight: h, edge: u32(edge))
    }

    @NodeMethod func multiTouch(_ type: String, _ x1: Double, _ y1: Double,
                                _ x2: Double, _ y2: Double, _ w: Int, _ h: Int) {
        injector.sendMultiTouch(type: type, x1: x1, y1: y1, x2: x2, y2: y2,
                                screenWidth: w, screenHeight: h)
    }

    @NodeMethod func button(_ button: String) {
        injector.sendButton(button: button, deviceUDID: udid)
    }

    @NodeMethod func buttonHid(_ page: Int, _ usage: Int, _ phase: String) {
        injector.sendButtonHID(page: u32(page), usage: u32(usage), phase: phase)
    }

    @NodeMethod func key(_ type: String, _ usage: Int) {
        injector.sendKey(type: type, usage: u32(usage))
    }

    /// NaN anchorX/anchorY mean "center" (the Swift API's nil).
    @NodeMethod func scroll(_ dx: Double, _ dy: Double,
                            _ anchorX: Double, _ anchorY: Double, _ w: Int, _ h: Int) {
        injector.sendScroll(dx: dx, dy: dy,
                            anchorX: anchorX.isNaN ? nil : anchorX,
                            anchorY: anchorY.isNaN ? nil : anchorY,
                            screenWidth: w, screenHeight: h)
    }

    @NodeMethod func digitalCrown(_ delta: Double) {
        injector.sendDigitalCrown(delta: delta)
    }

    @NodeMethod func orientation(_ orientation: Int) -> Bool {
        injector.sendOrientation(orientation: u32(orientation))
    }

    @NodeMethod func memoryWarning() {
        injector.simulateMemoryWarning()
    }

    @NodeMethod func softwareKeyboard() {
        injector.toggleSoftwareKeyboard()
    }

    @NodeMethod func caDebug(_ name: String, _ enabled: Bool) -> Bool {
        injector.setCADebugOption(name: name, enabled: enabled)
    }
}

// MARK: - Capture

/// In-process frame capture + encode for one simulator. MJPEG frames are always
/// produced; H.264/AVCC runs only while `setAvccActive(true)`. Encoded frames are
/// produced on a native encode thread and marshalled onto the JS thread through a
/// NodeAsyncQueue (threadsafe function), then handed to `onFrame` as
/// (codec, Buffer, width, height, flags).
@NodeClass @NodeActor final class SimCapture {
    private let engine: CaptureEngine
    private let onFrame: NodeFunction
    private let queue: NodeAsyncQueue

    @NodeConstructor init(_ udid: String, _ onFrame: NodeFunction) throws {
        // unref'd by NodeAsyncQueue's init, so the frame pipeline alone won't
        // keep the event loop alive. Bounded queue + blocking AVCC preserves
        // inter-frame ordering; MJPEG is nonblocking and drops under backpressure.
        let queue = try NodeAsyncQueue(label: "simCapture", maxQueueSize: 16)
        self.onFrame = onFrame
        self.queue = queue

        // Capture the locals (not self) so the closure can be built before the
        // engine property is initialized, and so it holds no strong ref to self.
        engine = CaptureEngine(deviceUDID: udid) { codec, data, w, h, flags in
            // Runs on a native encode thread. AVCC is inter-frame H.264 — dropping
            // a delta corrupts the decoder until the next IDR — so deliver it
            // blocking; MJPEG is stateless and safe to drop. We copy the bytes
            // into a managed Buffer (NodeBuffer(copying:)) on the JS thread:
            // external buffers crash Bun's GC under frame churn, and the
            // production CLI is a bun-compiled binary.
            let blocking = codec == CaptureEngine.codecAVCC
            try? queue.run(blocking: blocking) {
                _ = try? onFrame.call([
                    Int(codec), try NodeBuffer(copying: data),
                    Int(w), Int(h), Int(flags),
                ])
            }
        }
    }

    @NodeMethod func start() throws {
        try engine.start()
    }

    @NodeMethod func setAvccActive(_ active: Bool) {
        engine.setAvccActive(active)
    }

    @NodeMethod func requestKeyframe() {
        engine.requestKeyframe()
    }

    @NodeMethod func screenSize() -> [String: any NodePropertyConvertible] {
        let (w, h) = engine.screenSize()
        return ["width": w, "height": h]
    }

    @NodeMethod func stop() {
        engine.stop()
    }

    deinit {
        // Abort the queue first so any encode thread blocked in `run` unblocks
        // (its call returns .closing and the frame is dropped); then drain the
        // encoders so nothing can fire afterwards. The tsfn is released when
        // `queue` deinitializes after this body.
        try? queue.close()
        engine.stop()
    }
}

// MARK: - Accessibility

/// Run a blocking accessibility query off the JS event loop (on a background
/// queue) and resolve with its result, mirroring the old napi_async_work path.
private func axQuery(
    _ udid: String, _ body: @escaping @Sendable (String) throws -> String
) async throws -> String {
    try await withCheckedThrowingContinuation { cont in
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                cont.resume(returning: try body(udid))
            } catch {
                cont.resume(throwing: error)
            }
        }
    }
}

#NodeModule(exports: [
    "SimHID": SimHID.deferredConstructor,
    "SimCapture": SimCapture.deferredConstructor,
    // axDescribe(udid): Promise<string> — axe-shaped accessibility JSON.
    "axDescribe": try NodeFunction { (udid: String) async throws -> String in
        try await axQuery(udid) { udid in
            SimFrameworks.load()  // /ax may be hit before capture/HID load them
            let data = try AccessibilityBridge.shared.describeUI(udid: udid)
            return String(decoding: data, as: UTF8.self)
        }
    },
    // axFrontmost(udid): Promise<string> — JSON `{ bundleId, pid }`.
    "axFrontmost": try NodeFunction { (udid: String) async throws -> String in
        try await axQuery(udid) { udid in
            SimFrameworks.load()
            let info = try AccessibilityBridge.shared.frontmostApp(udid: udid)
            let data = try JSONSerialization.data(withJSONObject: info)
            return String(decoding: data, as: UTF8.self)
        }
    },
])
