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
        Task { try await injector.setup(deviceUDID: udid) }
    }

    @NodeMethod func touch(_ type: String, _ x: Double, _ y: Double,
                           _ w: Int, _ h: Int, _ edge: Int) async {
        await injector.sendTouch(type: type, x: x, y: y,
                           screenWidth: w, screenHeight: h, edge: u32(edge))
    }

    @NodeMethod func multiTouch(_ type: String, _ x1: Double, _ y1: Double,
                                _ x2: Double, _ y2: Double, _ w: Int, _ h: Int) async {
        await injector.sendMultiTouch(type: type, x1: x1, y1: y1, x2: x2, y2: y2,
                                screenWidth: w, screenHeight: h)
    }

    @NodeMethod func button(_ button: String) async {
        await injector.sendButton(button: button, deviceUDID: udid)
    }

    @NodeMethod func buttonHid(_ page: Int, _ usage: Int, _ phase: String) async {
        await injector.sendButtonHID(page: u32(page), usage: u32(usage), phase: phase)
    }

    @NodeMethod func key(_ type: String, _ usage: Int) async {
        await injector.sendKey(type: type, usage: u32(usage))
    }

    /// NaN anchorX/anchorY mean "center" (the Swift API's nil).
    @NodeMethod func scroll(_ dx: Double, _ dy: Double,
                            _ anchorX: Double, _ anchorY: Double, _ w: Int, _ h: Int) async {
        await injector.sendScroll(dx: dx, dy: dy,
                            anchorX: anchorX.isNaN ? nil : anchorX,
                            anchorY: anchorY.isNaN ? nil : anchorY,
                            screenWidth: w, screenHeight: h)
    }

    @NodeMethod func digitalCrown(_ delta: Double) async {
        await injector.sendDigitalCrown(delta: delta)
    }

    @NodeMethod func orientation(_ orientation: Int) async -> Bool {
        await injector.sendOrientation(orientation: u32(orientation))
    }

    @NodeMethod func memoryWarning() async {
        await injector.simulateMemoryWarning()
    }

    @NodeMethod func softwareKeyboard() async {
        await injector.toggleSoftwareKeyboard()
    }

    @NodeMethod func caDebug(_ name: String, _ enabled: Bool) async -> Bool {
        await injector.setCADebugOption(name: name, enabled: enabled)
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
    private let queue: NodeAsyncQueue

    @NodeConstructor init(_ udid: String) throws {
        // unref'd by NodeAsyncQueue's init, so the frame pipeline alone won't
        // keep the event loop alive. Bounded queue + blocking AVCC preserves
        // inter-frame ordering; MJPEG is nonblocking and drops under backpressure.
        let queue = try NodeAsyncQueue(label: "simCapture", maxQueueSize: 16)
        self.queue = queue
        self.engine = CaptureEngine(deviceUDID: udid)
    }

    // returns a function that can be called to unsubscribe
    @NodeMethod func subscribe(
        codec: Int,
        onFrame: NodeFunction
    ) async throws -> NodeFunction {
        let codecMJPEG: Int = 0
        let codecAVCC: Int = 1

        var buffer = try CaptureBuffer(initialCapacity: 1024 * 1024)
        let unsubscribe: @Sendable () async -> Void
        switch codec {
        case codecMJPEG:
            unsubscribe = await engine.addMJPEGConsumer { [self] dimensions, data in
                try? await queue.run {
                    let array = try buffer.setData(data)
                    _ = try? await onFrame.call([
                        array,
                        Int(dimensions.width), Int(dimensions.height),
                        0,
                    ]).as(NodePromise.self)?.value
                }
            }
        case codecAVCC:
            unsubscribe = await engine.addAVCCConsumer { [self] dimensions, data, flags in
                try? await queue.run {
                    let array = try buffer.setData(data)
                    _ = try? await onFrame.call([
                        array,
                        Int(dimensions.width), Int(dimensions.height),
                        Int(flags),
                    ]).as(NodePromise.self)?.value
                }
            }
        default:
            throw Errors.invalidCodec
        }
        return try NodeFunction { await unsubscribe() }
    }

    @NodeMethod func start() async throws {
        try await engine.start()
    }

    @NodeMethod func stop() async {
        await engine.stop()
    }

    deinit {
        Task { [engine] in await engine.stop() }
    }

    enum Errors: Error {
        case invalidCodec
    }
}

@NodeActor private struct CaptureBuffer {
    private var buffer: NodeArrayBuffer

    init(initialCapacity: Int) throws {
        buffer = try NodeArrayBuffer(capacity: initialCapacity)
    }

    mutating func setData(_ data: Data) throws -> NodeTypedArray<UInt8> {
        let hadSpace = try buffer.withUnsafeMutableBytes { buffer in
            guard data.count <= buffer.count else { return false }
            _ = data.copyBytes(to: buffer)
            return true
        }

        if !hadSpace {
            // allocate a new buffer with sufficient capacity. old buffer will be GC'd.
            buffer = try NodeArrayBuffer(capacity: data.count)
            _ = try buffer.withUnsafeMutableBytes { data.copyBytes(to: $0) }
        }

        return try NodeTypedArray<UInt8>(for: buffer, count: data.count)
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
