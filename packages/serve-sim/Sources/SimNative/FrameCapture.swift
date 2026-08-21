import Foundation
import CoreVideo
import CoreMedia
import CoreGraphics
import IOSurface
import ObjectiveC
import SimNativeSupport

/// Headless simulator frame capture via direct IOSurface access.
///
/// Uses SimulatorKit frame callbacks (via objc_msgSend on the IO port descriptor)
/// for event-driven capture with zero jitter. Maintains a 5fps idle floor
/// for late-joining clients.
///
/// Pipeline: IOSurface (shared memory) → CVPixelBuffer (zero-copy) → H.264 encode
actor FrameCapture {
    private let queue = DispatchSerialQueue(label: "frame-capture", qos: .userInteractive)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    private var photocopier = Photocopier()
    private var onFrame: ((CVPixelBuffer, CMTime) -> Void)?
    private var frameCount: UInt64 = 0
    private(set) var capturedWidth: Int = 0
    private(set) var capturedHeight: Int = 0
    private var idleTimer: Task<Void, Never>?
    private var lastCaptureTime: ContinuousClock.Instant = .now
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
    private static let idleInterval: ContinuousClock.Duration = .milliseconds(200)

    private var descriptors: [NSObject] = []
    private var callbackUUIDs: [ObjectIdentifier: UUID] = [:]
    private var ioClient: NSObject?
    private var expectedScreenSize: FramebufferSurfaceSize?
    private var didLogRejectedPresentationSurface = false
    private var didLogMissingExpectedSurface = false

    func start(deviceUDID: String, onFrame: @escaping @Sendable (CVPixelBuffer, CMTime) -> Void) throws {
        self.onFrame = onFrame

        SimFrameworks.load()
        guard let device = Self.findSimDevice(udid: deviceUDID) else {
            throw makeError(1, "Device \(deviceUDID) not found")
        }

        let state = device.value(forKey: "stateString") as? String ?? "unknown"
        guard state == "Booted" else {
            throw makeError(2, "Device not booted (state: \(state))")
        }
        self.expectedScreenSize = Self.nativeScreenSize(for: device)

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

    /// Return the descriptor matching the device type's native screen size.
    /// Xcode 27 can expose an additional 7680x4320 presentation surface while
    /// Device Hub is resizing; selecting the historical largest surface then
    /// feeds a non-device frame to VideoToolbox and produces `encodingFailed`.
    /// If screen metadata is unavailable, retain the old largest-live fallback.
    private func pickBestDescriptor() -> NSObject? {
        let surfSel = NSSelectorFromString("framebufferSurface")
        let sizes = descriptors.map { desc -> FramebufferSurfaceSize in
            guard let surfObj = desc.perform(surfSel)?.takeUnretainedValue() else {
                return FramebufferSurfaceSize(width: 0, height: 0)
            }
            let surf = unsafeBitCast(surfObj, to: IOSurface.self)
            return FramebufferSurfaceSize(
                width: IOSurfaceGetWidth(surf),
                height: IOSurfaceGetHeight(surf)
            )
        }
        guard let selection = FramebufferSurfaceSelector.select(
            from: sizes,
            expectedSize: expectedScreenSize
        ) else {
            return nil
        }

        if selection.matchedExpectedSize, !didLogRejectedPresentationSurface {
            let selected = sizes[selection.index]
            let selectedArea = Int64(selected.width) * Int64(selected.height)
            if let larger = sizes.filter(\.isLive).max(by: {
                Int64($0.width) * Int64($0.height) < Int64($1.width) * Int64($1.height)
            }), Int64(larger.width) * Int64(larger.height) > selectedArea {
                print(
                    "[capture] Ignoring non-device framebuffer \(larger.width)x\(larger.height); "
                    + "native screen is \(selected.width)x\(selected.height)"
                )
                didLogRejectedPresentationSurface = true
            }
        } else if
            !selection.matchedExpectedSize,
            let expectedScreenSize,
            !didLogMissingExpectedSurface
        {
            let selected = sizes[selection.index]
            print(
                "[capture] No framebuffer matches native screen "
                + "\(expectedScreenSize.width)x\(expectedScreenSize.height); "
                + "falling back to \(selected.width)x\(selected.height)"
            )
            didLogMissingExpectedSurface = true
        }
        return descriptors[selection.index]
    }

    // MARK: - Frame callbacks via objc_msgSend

    private func registerFrameCallbacks(desc: AnyObject) throws {
        let regSel = #selector(FramebufferDescriptor.registerScreenCallbacks)
        guard desc.responds(to: regSel) else {
            throw makeError(8, "Descriptor doesn't support registerScreenCallbacks")
        }

        let uuid = UUID()
        callbackUUIDs[ObjectIdentifier(desc)] = uuid

        desc.registerScreenCallbacks(
            uuid: uuid,
            callbackQueue: queue,
            frameCallback: { [self] in assumeIsolated { $0.captureFrame() } },
            surfacesChangedCallback: { [self] in assumeIsolated { $0.captureFrame() } },
            propertiesChangedCallback: {}
        )
    }

    private func startIdleTimer() {
        self.idleTimer = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.onIdleTimerTick()
                try? await Task.sleep(for: Self.idleInterval)
            }
        }
    }

    private func onIdleTimerTick() {
        let now = ContinuousClock.now
        guard (now - self.lastCaptureTime) >= Self.idleInterval else { return }
        self.captureFrame(force: true)
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

    // MARK: - Frame capture

    private func captureFrame(force: Bool = false) {
        guard let desc = pickBestDescriptor() else { return }

        let surfSel = NSSelectorFromString("framebufferSurface")
        guard let surfObj = desc.perform(surfSel)?.takeUnretainedValue() else { return }
        let surface = unsafeBitCast(surfObj, to: IOSurface.self)

        // Seed-skip: when the simulator's framebuffer content hasn't changed,
        // don't spend cycles re-encoding the same pixels back-to-back from the
        // frame-callback path. BUT: we must still re-emit at the idle floor
        // (~5 fps) so that downstream consumers keep seeing a live stream —
        // see the `idleInterval` doc-comment for why that matters.
        let key = ObjectIdentifier(desc)
        let seed = IOSurfaceGetSeed(surface)
        let seedChanged = lastSeeds[key] != seed
        if frameCount > 0, !seedChanged, !force { return }
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

        lastCaptureTime = .now
        frameCount += 1
        let timestamp = CMTime(value: CMTimeValue(frameCount), timescale: 60)
        guard let copy = photocopier.copy(pb) else { return }
        onFrame?(copy, timestamp)
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
        onFrame = nil
        frameCount = 0
        capturedWidth = 0
        capturedHeight = 0
        rewireTickCount = 0
        lastCaptureTime = .now
        ioClient = nil
        expectedScreenSize = nil
        didLogRejectedPresentationSurface = false
        didLogMissingExpectedSurface = false
    }

    // MARK: - Helpers

    private func makeError(_ code: Int, _ msg: String) -> NSError {
        NSError(domain: "FrameCapture", code: code,
                userInfo: [NSLocalizedDescriptionKey: msg])
    }

    /// SimDeviceType.mainScreenSize is private but stable across the same
    /// SimulatorKit versions already used by this file. Runtime validation on
    /// Xcode 27 confirms that it reports native pixels, not logical points, and
    /// matches the primary IOSurface exactly. The `@convention(c)` IMP type is
    /// intentional: it preserves the platform CGSize return ABI (registers on
    /// arm64 and the appropriate struct-return convention on x86_64).
    private static func nativeScreenSize(for device: NSObject) -> FramebufferSurfaceSize? {
        let deviceTypeSelector = NSSelectorFromString("deviceType")
        guard
            device.responds(to: deviceTypeSelector),
            let deviceType = device.perform(deviceTypeSelector)?.takeUnretainedValue() as? NSObject
        else {
            return nil
        }
        let selector = NSSelectorFromString("mainScreenSize")
        guard deviceType.responds(to: selector) else { return nil }

        typealias GetSize = @convention(c) (AnyObject, Selector) -> CGSize
        let getSize = unsafeBitCast(deviceType.method(for: selector), to: GetSize.self)
        let size = getSize(deviceType, selector)
        guard size.width.isFinite, size.height.isFinite else { return nil }

        let width = Int(size.width.rounded())
        let height = Int(size.height.rounded())
        guard width > 0, height > 0 else { return nil }
        return FramebufferSurfaceSize(width: width, height: height)
    }

    static func findSimDevice(udid: String) -> NSObject? {
        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let developerDir = Xcode.developerDir()
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
}

@objc protocol FramebufferDescriptor {
    @objc(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)
    func registerScreenCallbacks(
        uuid: UUID,
        callbackQueue: DispatchQueue,
        frameCallback: @convention(block) @escaping () -> Void,
        surfacesChangedCallback: @convention(block) @escaping () -> Void,
        propertiesChangedCallback: @convention(block) @escaping () -> Void
    )
}
