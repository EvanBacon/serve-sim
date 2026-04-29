import Foundation
import CoreVideo
import CoreMedia
import CoreGraphics
import IOSurface
import ObjectiveC

/// Headless simulator frame capture via direct IOSurface access.
///
/// Uses SimulatorKit frame callbacks (via objc_msgSend on the IO port descriptor)
/// for event-driven capture with zero jitter. Maintains a 5fps idle floor
/// for late-joining clients.
///
/// Pipeline: IOSurface (shared memory) → CVPixelBuffer (zero-copy) → H.264 encode
final class FrameCapture {
    private var onFrame: ((CVPixelBuffer, CMTime) -> Void)?
    private var frameCount: UInt64 = 0
    private(set) var capturedWidth: Int = 0
    private(set) var capturedHeight: Int = 0
    private var idleTimer: DispatchSourceTimer?
    private let captureQueue = DispatchQueue(label: "frame-capture", qos: .userInteractive)
    private var lastCaptureTimeMs: UInt64 = 0
    private var lastSeeds: [ObjectIdentifier: UInt32] = [:]
    private var rewireTickCount: Int = 0
    /// Interval at which the idle timer re-emits the current frame even when
    /// the simulator isn't rendering anything new. This is load-bearing for two
    /// consumers:
    /// 1. Browsers rendering `<img src="…/stream.mjpeg">` only render a multipart
    ///    chunk once the NEXT boundary arrives, so a single static frame never
    ///    paints until something changes.
    /// 2. Any upstream MJPEG→WebSocket relay only caches a frame when at least
    ///    one subscriber is due for it — a late-joining relay subscriber on an
    ///    idle sim never gets a cached frame to show.
    /// Re-emitting at ~5 fps fixes both without meaningful CPU cost.
    private static let idleIntervalMs: UInt64 = 200

    private var descriptors: [NSObject] = []
    private var callbackUUIDs: [ObjectIdentifier: NSUUID] = [:]
    private var ioClient: NSObject?

    func start(deviceUDID: String, onFrame: @escaping (CVPixelBuffer, CMTime) -> Void) throws {
        self.onFrame = onFrame

        _ = dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)
        _ = dlopen("/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW)

        guard let device = Self.findSimDevice(udid: deviceUDID) else {
            throw makeError(1, "Device \(deviceUDID) not found")
        }

        let state = device.value(forKey: "stateString") as? String ?? "unknown"
        guard state == "Booted" else {
            throw makeError(2, "Device not booted (state: \(state))")
        }

        guard let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject else {
            throw makeError(3, "Failed to get device IO")
        }
        self.ioClient = io

        try wireUpFramebuffer()
        startIdleTimer()
        print("[capture] Frame callbacks registered (event-driven) + 5fps idle floor")
    }

    /// Find all framebuffer display descriptors, register callbacks on each,
    /// and cache them. Safe to re-call if the cached descriptors become stale.
    ///
    /// The simulator exposes multiple `com.apple.framebuffer.display` ports
    /// (main screen + secondary planes/overlays). We can't reliably tell which
    /// one is the primary up-front, so we listen on all of them and let
    /// `captureFrame()` pick whichever currently has the largest live surface.
    private func wireUpFramebuffer() throws {
        guard let io = ioClient else {
            throw makeError(3, "No IO client")
        }

        // Refresh ports — descriptors are created lazily.
        io.perform(NSSelectorFromString("updateIOPorts"))

        let candidates = try findFramebufferDescriptors(io: io)

        // Tear down old callbacks.
        let unregSel = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
        for oldDesc in descriptors {
            if let uuid = callbackUUIDs[ObjectIdentifier(oldDesc)],
               oldDesc.responds(to: unregSel) {
                oldDesc.perform(unregSel, with: uuid)
            }
        }
        callbackUUIDs.removeAll()
        lastSeeds.removeAll()
        descriptors = candidates

        // Registering screen callbacks is what causes SimulatorKit to wire the
        // display pipeline to our client and populate `framebufferSurface`.
        for desc in candidates {
            try registerFrameCallbacks(desc: desc)
        }

        if let best = pickBestDescriptor() {
            let surfSel = NSSelectorFromString("framebufferSurface")
            if let surfObj = best.perform(surfSel)?.takeUnretainedValue() {
                let surf = unsafeBitCast(surfObj, to: IOSurface.self)
                capturedWidth = IOSurfaceGetWidth(surf)
                capturedHeight = IOSurfaceGetHeight(surf)
                print("[capture] Framebuffer: \(capturedWidth)x\(capturedHeight) (direct IOSurface, zero-copy)")
            }
        }

        captureFrame()
    }

    private func findFramebufferDescriptors(io: NSObject) throws -> [NSObject] {
        guard let ports = io.value(forKey: "deviceIOPorts") as? [NSObject] else {
            throw makeError(4, "Failed to get IO ports")
        }

        let pidSel = NSSelectorFromString("portIdentifier")
        let descSel = NSSelectorFromString("descriptor")
        let surfSel = NSSelectorFromString("framebufferSurface")

        var candidates: [NSObject] = []
        for port in ports {
            guard port.responds(to: pidSel),
                  let pid = port.perform(pidSel)?.takeUnretainedValue(),
                  "\(pid)" == "com.apple.framebuffer.display",
                  port.responds(to: descSel),
                  let desc = port.perform(descSel)?.takeUnretainedValue() as? NSObject,
                  desc.responds(to: surfSel)
            else { continue }
            candidates.append(desc)
        }

        if candidates.isEmpty {
            throw makeError(5, "No framebuffer display descriptor found")
        }
        return candidates
    }

    /// Return the descriptor whose live surface has the largest area.
    /// Secondary planes/overlays are typically smaller than the main screen.
    private func pickBestDescriptor() -> NSObject? {
        let surfSel = NSSelectorFromString("framebufferSurface")
        var best: NSObject?
        var bestArea: Int = 0
        for desc in descriptors {
            guard let surfObj = desc.perform(surfSel)?.takeUnretainedValue() else { continue }
            let surf = unsafeBitCast(surfObj, to: IOSurface.self)
            let area = IOSurfaceGetWidth(surf) * IOSurfaceGetHeight(surf)
            if area > bestArea {
                best = desc
                bestArea = area
            }
        }
        return best
    }

    // MARK: - Frame callbacks via objc_msgSend

    private func registerFrameCallbacks(desc: NSObject) throws {
        let regSel = NSSelectorFromString("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:")
        guard desc.responds(to: regSel) else {
            throw makeError(8, "Descriptor doesn't support registerScreenCallbacks")
        }

        guard let msgSendPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend") else {
            throw makeError(9, "objc_msgSend not found")
        }

        typealias MsgSendFunc = @convention(c) (
            AnyObject, Selector, AnyObject, AnyObject, AnyObject, AnyObject, AnyObject
        ) -> Void
        let msgSend = unsafeBitCast(msgSendPtr, to: MsgSendFunc.self)

        let uuid = NSUUID()
        callbackUUIDs[ObjectIdentifier(desc)] = uuid

        let frameCallback: @convention(block) () -> Void = { [weak self] in
            self?.captureQueue.async { self?.captureFrame() }
        }
        let surfacesCallback: @convention(block) () -> Void = { [weak self] in
            self?.captureQueue.async { self?.captureFrame() }
        }
        let propsCallback: @convention(block) () -> Void = {}

        msgSend(
            desc, regSel,
            uuid, captureQueue as AnyObject,
            frameCallback as AnyObject, surfacesCallback as AnyObject, propsCallback as AnyObject
        )
    }

    private func startIdleTimer() {
        let timer = DispatchSource.makeTimerSource(queue: captureQueue)
        timer.schedule(deadline: .now().advanced(by: .milliseconds(Int(Self.idleIntervalMs))),
                       repeating: .milliseconds(Int(Self.idleIntervalMs)))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let nowMs = DispatchTime.now().uptimeNanoseconds / 1_000_000
            if (nowMs - self.lastCaptureTimeMs) >= Self.idleIntervalMs {
                self.captureFrame()
            }
            // Self-heal: if we've never captured a frame, the cached descriptor
            // is likely stale. Re-wire the pipeline periodically (every ~1s)
            // until frames start flowing.
            if self.frameCount == 0 {
                self.rewireTickCount += 1
                if self.rewireTickCount % 5 == 0 {
                    do {
                        try self.wireUpFramebuffer()
                    } catch {
                        // Swallow — we'll try again on the next tick.
                    }
                }
            }
        }
        timer.resume()
        self.idleTimer = timer
    }

    // MARK: - Frame capture

    private func captureFrame() {
        guard let desc = pickBestDescriptor() else { return }

        let surfSel = NSSelectorFromString("framebufferSurface")
        guard let surfObj = desc.perform(surfSel)?.takeUnretainedValue() else { return }
        let surface = unsafeBitCast(surfObj, to: IOSurface.self)

        // Seed-skip: when the simulator's framebuffer content hasn't changed,
        // don't spend cycles re-encoding the same pixels back-to-back from the
        // frame-callback path. BUT: we must still re-emit at the idle floor
        // (~5 fps) so that downstream consumers keep seeing a live stream —
        // see the `idleIntervalMs` doc-comment for why that matters.
        let key = ObjectIdentifier(desc)
        let seed = IOSurfaceGetSeed(surface)
        let nowMs = DispatchTime.now().uptimeNanoseconds / 1_000_000
        let sinceLastMs = nowMs &- lastCaptureTimeMs
        let seedChanged = lastSeeds[key] != seed
        let idleRefreshDue = frameCount > 0 && sinceLastMs >= Self.idleIntervalMs
        if frameCount > 0, !seedChanged, !idleRefreshDue { return }
        lastSeeds[key] = seed

        let w = IOSurfaceGetWidth(surface)
        let h = IOSurfaceGetHeight(surface)
        guard w > 0, h > 0 else { return }

        if capturedWidth != w || capturedHeight != h {
            capturedWidth = w
            capturedHeight = h
            print("[capture] Surface size changed: \(w)x\(h)")
        }

        var pixelBuffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault, surface,
            [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer?.takeRetainedValue() else { return }

        lastCaptureTimeMs = nowMs
        frameCount += 1
        let timestamp = CMTime(value: CMTimeValue(frameCount), timescale: 60)
        onFrame?(pb, timestamp)
    }

    func getScreenSize() -> (width: Int, height: Int)? {
        guard capturedWidth > 0, capturedHeight > 0 else { return nil }
        return (capturedWidth, capturedHeight)
    }

    func stop() {
        idleTimer?.cancel()
        idleTimer = nil

        let unregSel = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
        for desc in descriptors {
            if let uuid = callbackUUIDs[ObjectIdentifier(desc)],
               desc.responds(to: unregSel) {
                desc.perform(unregSel, with: uuid)
            }
        }
        callbackUUIDs.removeAll()
        descriptors.removeAll()
        lastSeeds.removeAll()
        ioClient = nil
    }

    // MARK: - Helpers

    private func makeError(_ code: Int, _ msg: String) -> NSError {
        NSError(domain: "FrameCapture", code: code,
                userInfo: [NSLocalizedDescriptionKey: msg])
    }

    static func findSimDevice(udid: String) -> NSObject? {
        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let developerDir = getDeveloperDir()
        let sharedSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        guard let context = contextClass.perform(sharedSel, with: developerDir, with: nil)?
                .takeUnretainedValue() as? NSObject else { return nil }
        let deviceSetSel = NSSelectorFromString("defaultDeviceSetWithError:")
        guard let deviceSet = context.perform(deviceSetSel, with: nil)?
                .takeUnretainedValue() as? NSObject else { return nil }
        guard let devices = deviceSet.value(forKey: "devices") as? [NSObject] else { return nil }
        return devices.first(where: {
            ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid
        })
    }

    static func getDeveloperDir() -> String {
        let pipe = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        process.arguments = ["-p"]
        process.standardOutput = pipe
        try? process.run()
        process.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "/Applications/Xcode.app/Contents/Developer"
    }
}
