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
    private var onFrame: ((CVPixelBuffer, CMTime, Bool) -> Void)?
    private var pixelConsumers: PixelConsumerCount?
    private var frameCount: UInt64 = 0
    private(set) var capturedWidth: Int = 0
    private(set) var capturedHeight: Int = 0
    private var idleTimer: Task<Void, Never>?
    private var lastCaptureTime: ContinuousClock.Instant = .now
    private var lastStamps: [ObjectIdentifier: SurfaceFrameStamp] = [:]
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
    private var expectedScreenSizes: [FramebufferSurfaceSize] = []
    private var preferredScreenSize: FramebufferSurfaceSize?
    private var didLogRejectedPresentationSurface = false
    private var didLogMissingExpectedSurface = false
    // Diagnostics for `serve-sim doctor`: what was live, what was chosen, why.
    private var lastCandidates: [FramebufferSurfaceSize] = []
    private var lastSelectedIndex: Int?
    private var lastSelectionReason = "none"
    private var sizeChanges: [[String: Any]] = []
    private var sourceCache = FramebufferSourceCache<FramebufferSource>(maxAge: 1.0)
    private var recheckGeneration: UInt64 = 0

    /// `onFrame(buffer, captureTime, isPrivateCopy)`: frames are deep-copied only
    /// while `pixelConsumers` is non-empty; otherwise the buffer wraps the live
    /// framebuffer surface and is only good for its dimensions.
    func start(
        deviceUDID: String,
        pixelConsumers: PixelConsumerCount,
        onFrame: @escaping @Sendable (CVPixelBuffer, CMTime, Bool) -> Void
    ) throws {
        self.onFrame = onFrame
        self.pixelConsumers = pixelConsumers

        SimFrameworks.load()
        guard let device = Self.findSimDevice(udid: deviceUDID) else {
            throw makeError(1, "Device \(deviceUDID) not found")
        }

        let state = device.value(forKey: "stateString") as? String ?? "unknown"
        guard state == "Booted" else {
            throw makeError(2, "Device not booted (state: \(state))")
        }
        self.expectedScreenSizes = Self.nativeScreenSizes(for: device)
        if expectedScreenSizes.count > 1 {
            let summary = expectedScreenSizes.map { "\($0.width)x\($0.height)" }.joined(separator: ", ")
            print("[capture] Device has \(expectedScreenSizes.count) native displays: \(summary)")
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
        lastStamps.removeAll()
        sourceCache.invalidate()
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
        lastCandidates = sizes
        guard let selection = FramebufferSurfaceSelector.select(
            from: sizes,
            expectedSizes: expectedScreenSizes,
            preferredSize: preferredScreenSize
        ) else {
            lastSelectedIndex = nil
            lastSelectionReason = "no_live_surface"
            return nil
        }
        lastSelectedIndex = selection.index
        lastSelectionReason = Self.selectionReason(
            selection, selected: sizes[selection.index], preferred: preferredScreenSize
        )

        if selection.matchedExpectedSize, !didLogRejectedPresentationSurface {
            let selected = sizes[selection.index]
            let selectedArea = Int64(selected.width) * Int64(selected.height)
            if let larger = sizes.filter(\.isLive).max(by: {
                Int64($0.width) * Int64($0.height) < Int64($1.width) * Int64($1.height)
            }), Int64(larger.width) * Int64(larger.height) > selectedArea {
                // On a foldable the larger surface is usually the other native
                // panel (Duo inner), not a presentation surface. Say which.
                if expectedScreenSizes.contains(where: { Self.sameSize($0, larger) }) {
                    print(
                        "[capture] Selected native display \(selected.width)x\(selected.height) "
                        + "(\(lastSelectionReason)); other native display \(larger.width)x\(larger.height) is also live"
                    )
                } else {
                    print(
                        "[capture] Ignoring non-device framebuffer \(larger.width)x\(larger.height); "
                        + "native screen is \(selected.width)x\(selected.height)"
                    )
                }
                didLogRejectedPresentationSurface = true
            }
        } else if
            !selection.matchedExpectedSize,
            !expectedScreenSizes.isEmpty,
            !didLogMissingExpectedSurface
        {
            let selected = sizes[selection.index]
            let expected = expectedScreenSizes.map { "\($0.width)x\($0.height)" }.joined(separator: ", ")
            print(
                "[capture] No framebuffer matches native screen(s) \(expected); "
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

        // Explicitly typed locals keep the type checker from choking on the
        // dynamic AnyObject call (some Xcode swiftc builds crash otherwise).
        let frameCallback: @convention(block) () -> Void = { [self, weak desc] in
            assumeIsolated { capture in
                capture.onFrameCallback(from: desc)
            }
        }
        let surfacesChangedCallback: @convention(block) () -> Void = { [self] in
            assumeIsolated { capture in
                _ = capture.captureFrame(trigger: .surfacesChanged)
            }
        }
        let propertiesChangedCallback: @convention(block) () -> Void = {}

        desc.registerScreenCallbacks(
            uuid: uuid,
            callbackQueue: queue,
            frameCallback: frameCallback,
            surfacesChangedCallback: surfacesChangedCallback,
            propertiesChangedCallback: propertiesChangedCallback
        )
    }

    /// `desc` is nil once the registering descriptor has been released.
    private func onFrameCallback(from desc: AnyObject?) {
        var fromCached = false
        if let desc, let current = sourceCache.current?.descriptor {
            fromCached = current === desc
        }
        onFrameCallback(trigger: fromCached ? .frame : .otherDescriptorFrame)
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
        self.captureFrame(force: true, trigger: .idleTick)
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

    /// Resolve the selected descriptor and its current IOSurface. Every
    /// `framebufferSurface` read is an XPC round-trip, so frame callbacks go
    /// through `sourceCache` instead of calling this directly.
    private func resolveSource() -> FramebufferSource? {
        guard let desc = pickBestDescriptor() else { return nil }
        let surfSel = NSSelectorFromString("framebufferSurface")
        guard let surfObj = desc.perform(surfSel)?.takeUnretainedValue() else { return nil }
        return FramebufferSource(descriptor: desc, surface: unsafeBitCast(surfObj, to: IOSurface.self))
    }

    /// Returns false only when the frame was skipped because the surface and
    /// its seed hadn't changed (see `onFrameCallback`).
    @discardableResult
    private func captureFrame(force: Bool = false, trigger: FramebufferSourceCache<FramebufferSource>.Trigger = .frame) -> Bool {
        let now = Double(DispatchTime.now().uptimeNanoseconds) / 1e9
        guard let source = sourceCache.source(for: trigger, now: now, resolve: resolveSource) else { return true }
        let desc = source.descriptor
        let surface = source.surface

        // Seed-skip: when the simulator's framebuffer content hasn't changed,
        // don't spend cycles re-encoding the same pixels back-to-back from the
        // frame-callback path. BUT: we must still re-emit at the idle floor
        // (~5 fps) so that downstream consumers keep seeing a live stream —
        // see the `idleInterval` doc-comment for why that matters. The surface
        // ID is part of the stamp so a swapped-in surface whose seed happens to
        // match the old one's still counts as new content.
        let key = ObjectIdentifier(desc)
        let stamp = SurfaceFrameStamp(surfaceID: IOSurfaceGetID(surface), seed: IOSurfaceGetSeed(surface))
        let contentChanged = lastStamps[key] != stamp
        if frameCount > 0, !contentChanged, !force { return false }
        lastStamps[key] = stamp

        let w = IOSurfaceGetWidth(surface)
        let h = IOSurfaceGetHeight(surface)
        guard w > 0, h > 0 else { return true }

        if capturedWidth != w || capturedHeight != h {
            let from = "\(capturedWidth)x\(capturedHeight)"
            capturedWidth = w
            capturedHeight = h
            print("[capture] Surface size changed: \(from) -> \(w)x\(h) (\(lastSelectionReason))")
            let change: [String: Any] = [
                "at": isoTimestamp(Date()),
                "from": from,
                "to": "\(w)x\(h)",
                "reason": lastSelectionReason,
            ]
            sizeChanges.append(change)
            if sizeChanges.count > 20 { sizeChanges.removeFirst(sizeChanges.count - 20) }
        }

        var pixelBuffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault, surface,
            [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer?.takeRetainedValue() else { return true }

        lastCaptureTime = .now
        frameCount += 1
        // Monotonic capture time (uptime ns): recordings place frames by it.
        let timestamp = CMTime(value: CMTimeValue(DispatchTime.now().uptimeNanoseconds), timescale: 1_000_000_000)
        if pixelConsumers?.isEmpty ?? false {
            onFrame?(pb, timestamp, false)
            return true
        }
        guard let copy = photocopier.copy(pb) else { return true }
        onFrame?(copy, timestamp, true)
        return true
    }

    /// Frame callbacks can arrive before the surface seed reflects the new
    /// frame. If this one finds the seed unchanged, re-check briefly instead of
    /// leaving the frame for the idle tick. A newer callback supersedes it.
    private func onFrameCallback(trigger: FramebufferSourceCache<FramebufferSource>.Trigger) {
        recheckGeneration &+= 1
        if captureFrame(trigger: trigger) { return }
        scheduleSeedRecheck(generation: recheckGeneration, attempt: 0)
    }

    private func scheduleSeedRecheck(generation: UInt64, attempt: Int) {
        guard let delay = SeedRecheckSchedule.delayMs(afterAttempt: attempt) else { return }
        queue.asyncAfter(deadline: .now() + .milliseconds(delay)) { [weak self] in
            self?.assumeIsolated { capture in
                guard capture.recheckGeneration == generation, capture.onFrame != nil else { return }
                if !capture.captureFrame() {
                    capture.scheduleSeedRecheck(generation: generation, attempt: attempt + 1)
                }
            }
        }
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
        lastStamps.removeAll()
        sourceCache.invalidate()
        onFrame = nil
        pixelConsumers = nil
        frameCount = 0
        capturedWidth = 0
        capturedHeight = 0
        rewireTickCount = 0
        lastCaptureTime = .now
        ioClient = nil
        expectedScreenSizes = []
        preferredScreenSize = nil
        didLogRejectedPresentationSurface = false
        didLogMissingExpectedSurface = false
        lastCandidates = []
        lastSelectedIndex = nil
        lastSelectionReason = "none"
        sizeChanges = []
    }

    /// Emit the current screen now (e.g. a viewer just subscribed).
    func requestFrame() {
        captureFrame(force: true)
    }

    /// A private copy of the current screen, for one-off snapshots. Taken at
    /// call time from the cached surface rather than retaining a wrapper of
    /// SimulatorKit's live (recycled) framebuffer between frames.
    func copyCurrentFrame() -> CVPixelBuffer? {
        let now = Double(DispatchTime.now().uptimeNanoseconds) / 1e9
        guard frameCount > 0,
              let source = sourceCache.source(for: .frame, now: now, resolve: resolveSource) else { return nil }
        var pixelBuffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault, source.surface,
            [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer?.takeRetainedValue() else { return nil }
        return photocopier.copy(pb)
    }

    func setPreferredScreenSize(width: Int, height: Int) {
        if width > 0, height > 0 {
            preferredScreenSize = FramebufferSurfaceSize(width: width, height: height)
        } else {
            preferredScreenSize = nil
        }
        didLogRejectedPresentationSurface = false
        didLogMissingExpectedSurface = false
        captureFrame(force: true, trigger: .preferredSizeChanged)
    }

    /// JSON snapshot of display selection for `serve-sim doctor`.
    func diagnosticsJSON() -> String {
        func size(_ s: FramebufferSurfaceSize) -> [String: Any] { ["width": s.width, "height": s.height] }
        let candidates: [[String: Any]] = lastCandidates.enumerated().map { entry -> [String: Any] in
            [
                "width": entry.element.width,
                "height": entry.element.height,
                "live": entry.element.isLive,
                "native": expectedScreenSizes.contains(where: { Self.sameSize($0, entry.element) }),
                "selected": entry.offset == lastSelectedIndex,
            ]
        }
        let age = ContinuousClock.now - lastCaptureTime
        let ageMs = Int(age.components.seconds) * 1000
            + Int(age.components.attoseconds / 1_000_000_000_000_000)
        var object: [String: Any] = [
            "native_displays": expectedScreenSizes.map(size),
            "candidates": candidates,
            "selection_reason": lastSelectionReason,
            "captured": ["width": capturedWidth, "height": capturedHeight],
            "frame_count": Int(frameCount),
            "size_changes": sizeChanges,
        ]
        if frameCount > 0 { object["last_frame_age_ms"] = ageMs }
        if let preferredScreenSize { object["preferred"] = size(preferredScreenSize) }
        return jsonString(object)
    }

    private static func sameSize(_ a: FramebufferSurfaceSize, _ b: FramebufferSurfaceSize) -> Bool {
        (a.width == b.width && a.height == b.height) || (a.width == b.height && a.height == b.width)
    }

    /// preferred: pinned by the Duo panel follower (or WS 0x0d).
    /// native_smallest: no pin; smallest native display (foldable rest pose).
    /// largest_fallback: no native-size metadata matched.
    private static func selectionReason(
        _ selection: FramebufferSurfaceSelection,
        selected: FramebufferSurfaceSize,
        preferred: FramebufferSurfaceSize?
    ) -> String {
        if let preferred, preferred.isLive, sameSize(preferred, selected) { return "preferred" }
        return selection.matchedExpectedSize ? "native_smallest" : "largest_fallback"
    }

    // MARK: - Helpers

    private func makeError(_ code: Int, _ msg: String) -> NSError {
        NSError(domain: "FrameCapture", code: code,
                userInfo: [NSLocalizedDescriptionKey: msg])
    }

    /// Native pixel sizes for every integrated digitizer display on this device
    /// type. Foldables list more than one (iPhone Duo cover + inner). Falls back
    /// to `SimDeviceType.mainScreenSize` when the capabilities plist is missing.
    private static func nativeScreenSizes(for device: NSObject) -> [FramebufferSurfaceSize] {
        if let fromCapabilities = sizesFromCapabilities(device), !fromCapabilities.isEmpty {
            return fromCapabilities
        }
        if let main = mainScreenSize(for: device) {
            return [main]
        }
        return []
    }

    private static func sizesFromCapabilities(_ device: NSObject) -> [FramebufferSurfaceSize]? {
        guard let deviceType = deviceType(for: device) else { return nil }
        let bundlePath: String?
        if let path = deviceType.value(forKey: "bundlePath") as? String {
            bundlePath = path
        } else if let url = deviceType.value(forKey: "bundleURL") as? URL {
            bundlePath = url.path
        } else {
            bundlePath = nil
        }
        guard let bundlePath else { return nil }
        let capPath = (bundlePath as NSString).appendingPathComponent("Contents/Resources/capabilities.plist")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: capPath)) else { return nil }
        return DeviceDisplaySizes.nativeSizes(fromCapabilitiesPlist: data)
    }

    /// SimDeviceType.mainScreenSize is private but stable across the same
    /// SimulatorKit versions already used by this file. Runtime validation on
    /// Xcode 27 confirms that it reports native pixels, not logical points, and
    /// matches the primary IOSurface exactly. The `@convention(c)` IMP type is
    /// intentional: it preserves the platform CGSize return ABI (registers on
    /// arm64 and the appropriate struct-return convention on x86_64).
    private static func mainScreenSize(for device: NSObject) -> FramebufferSurfaceSize? {
        guard let deviceType = deviceType(for: device) else { return nil }
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

    private static func deviceType(for device: NSObject) -> NSObject? {
        let deviceTypeSelector = NSSelectorFromString("deviceType")
        guard
            device.responds(to: deviceTypeSelector),
            let deviceType = device.perform(deviceTypeSelector)?.takeUnretainedValue() as? NSObject
        else {
            return nil
        }
        return deviceType
    }

    static func findSimDevice(udid: String) -> NSObject? {
        guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let developerDir = Xcode.developerDir()
        let sharedSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        guard let context = contextClass.perform(sharedSel, with: developerDir, with: nil)?
                .takeUnretainedValue() as? NSObject else { return nil }
        guard let deviceSet = DeviceSet.lookUp({ selectorName, path -> NSObject? in
            let deviceSetSel = NSSelectorFromString(selectorName)
            guard context.responds(to: deviceSetSel) else { return nil }
            let deviceSetResult: Unmanaged<AnyObject>?
            if let path {
                deviceSetResult = context.perform(deviceSetSel, with: path, with: nil)
            } else {
                deviceSetResult = context.perform(deviceSetSel, with: nil)
            }
            return deviceSetResult?.takeUnretainedValue() as? NSObject
        }) else { return nil }
        guard let devices = deviceSet.value(forKey: "devices") as? [NSObject] else { return nil }
        return devices.first(where: {
            ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid
        })
    }
}

struct FramebufferSource {
    let descriptor: NSObject
    let surface: IOSurface
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
