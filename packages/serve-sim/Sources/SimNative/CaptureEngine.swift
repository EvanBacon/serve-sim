import Foundation
import CoreVideo
import CoreMedia
import os

// The capture + encode engine, reused verbatim from SimStreamHelper. Replicates
// main.swift's frameHandler: MJPEG always encodes while clients exist; H.264 runs
// only while AVCC is active. Encoded bytes (JPEG, or natively-framed AVCC
// envelopes) are handed back through a Swift closure on a native encode thread;
// the node-swift binding (sim-module.swift) marshals them onto the JS thread via
// a NodeAsyncQueue (threadsafe function).

struct Frame: Identifiable {
    let id = UUID()
    let pixelBuffer: CVPixelBuffer
    /// False when `pixelBuffer` wraps SimulatorKit's live framebuffer surface
    /// (no pixel consumer was attached, so the private copy was skipped). Such
    /// frames are only good for their dimensions.
    var isPrivateCopy = true
}

protocol FrameEncoder {
    associatedtype Encoded
    /// Whether this encoder reads pixels (and so needs a private frame copy).
    static var readsPixels: Bool { get }
    func encode(_ frame: Frame) async throws -> Encoded
}

extension FrameEncoder {
    static var readsPixels: Bool { true }
}

protocol CaptureConsuming: Sendable {
    // this is intentionally synchronous. CaptureEngine sends all frames to all consumers,
    // and lets them handle internal backpressure as they see fit. if instead this were async
    // (and CaptureEngine waited for all consumers to finish), a single bad consumer could
    // jam up the entire pipeline.
    func handleFrame(_ frame: Frame)
}

actor CaptureConsumer<E: FrameEncoder>: CaptureConsuming {
    nonisolated let continuation: AsyncStream<Frame>.Continuation

    init(
        encoder: E,
        diagnostics: EncoderDiagnostics? = nil,
        onFrame: @escaping @isolated(any) (E.Encoded) async -> Void
    ) {
        let codec = String(describing: E.self).replacingOccurrences(of: "Encoder", with: "")
        let (stream, continuation) = AsyncStream.makeStream(
            of: Frame.self,
            // drop old frames if there's backpressure
            bufferingPolicy: .bufferingNewest(1)
        )
        self.continuation = continuation
        Task {
            _ = onFrame.isolation
            for await frame in stream {
                do {
                    let encoded = try await encoder.encode(frame)
                    diagnostics?.recordSuccess(codec: codec)
                    await onFrame(encoded)
                } catch {
                    // One line per distinct failure plus periodic counts; the
                    // per-frame print used to flood the log (x20 per second).
                    let size = frame.pixelBuffer.dimensions
                    if let diagnostics {
                        diagnostics.recordFailure(codec: codec, error: error, width: size.width, height: size.height)
                    } else {
                        print("error encoding \(E.self) frame: \(error)")
                    }
                    continue
                }
            }
        }
    }

    nonisolated func handleFrame(_ frame: Frame) {
        if E.readsPixels, !frame.isPrivateCopy { return }
        continuation.yield(frame)
    }

    deinit { continuation.finish() }
}

actor CaptureEngine {
    private enum Phase {
        case unstarted
        case starting
        case running
        case stopped
    }

    private let deviceUDID: String
    /// Optional cap (bits/s) on the resolution-scaled H.264 bitrate.
    private let maxBitrate: Int?
    private let frameCapture = FrameCapture()
    private var phase = Phase.unstarted

    // mjpeg is stateless so we can share a single encoder instance
    private let mjpegEncoder = MJPEGEncoder()
    private let encoderDiagnostics = EncoderDiagnostics()
    // Separate so viewer seeds don't queue behind (or evict the cache of)
    // per-frame MJPEG viewer encodes.
    private let snapshotEncoder = MJPEGEncoder()

    private(set) var screenSize = Dimensions(width: 0, height: 0)
    private var consumers = [UUID: CaptureConsuming]()
    /// Number of attached consumers that read pixels. FrameCapture only pays
    /// for the private per-frame copy while this is non-zero.
    private let pixelConsumers = PixelConsumerCount()

    init(deviceUDID: String, maxBitrate: Int? = nil) {
        self.deviceUDID = deviceUDID
        self.maxBitrate = maxBitrate
    }

    func setPreferredScreenSize(width: Int, height: Int) async {
        await frameCapture.setPreferredScreenSize(width: width, height: height)
    }

    /// JSON snapshot for `serve-sim doctor`: display selection + encoder state.
    func diagnostics() async -> String {
        let capture = await frameCapture.diagnosticsJSON()
        let encoders = jsonString(encoderDiagnostics.snapshot())
        let phaseName: String
        switch phase {
        case .unstarted: phaseName = "unstarted"
        case .starting: phaseName = "starting"
        case .running: phaseName = "running"
        case .stopped: phaseName = "stopped"
        }
        return "{\"phase\":\"\(phaseName)\",\"consumers\":\(consumers.count),\"capture\":\(capture),\"encoders\":\(encoders)}"
    }

    func start() async throws {
        guard phase == .unstarted else { return }
        phase = .starting
        // Latch `started` only after capture actually begins: if start() throws
        // (e.g. device not booted), a later retry should still be allowed.
        let (frames, frameContinuation) = AsyncStream.makeStream(
            of: Frame.self,
            // drop old frames if there's backpressure
            bufferingPolicy: .bufferingNewest(1)
        )
        do {
            try await frameCapture.start(deviceUDID: deviceUDID, pixelConsumers: pixelConsumers) { pixelBuffer, _, isCopy in
                frameContinuation.yield(Frame(pixelBuffer: pixelBuffer, isPrivateCopy: isCopy))
            }
        } catch {
            // Preserve retryability after an ordinary start failure, but never
            // overwrite a concurrent stop() that moved the actor to .stopped.
            frameContinuation.finish()
            await frameCapture.stop()
            if phase == .starting { phase = .unstarted }
            throw error
        }
        // Actor methods are reentrant across the await above. A simulator can
        // be shut down while FrameCapture is starting; do not resurrect a
        // session that stop() already marked stopped.
        guard phase == .starting else {
            frameContinuation.finish()
            await frameCapture.stop()
            throw CancellationError()
        }
        Task {
            for await frame in frames {
                handleFrame(frame)
            }
        }
        phase = .running
    }

    private func addConsumer<E: FrameEncoder>(
        encoder: E,
        onFrame: sending @escaping @isolated(any) (E.Encoded) async -> Void
    ) -> (@Sendable () async -> Void) {
        let consumer = CaptureConsumer(encoder: encoder, diagnostics: encoderDiagnostics) { [weak self] encoded in
            guard let self, await self.phase == .running else { return }
            await onFrame(encoded)
        }
        let id = UUID()
        consumers[id] = consumer
        if E.readsPixels {
            pixelConsumers.increment()
            // Emit a copied frame now rather than waiting for the next screen
            // change or idle tick, so a new viewer's first IDR is immediate.
            Task { [frameCapture] in await frameCapture.requestFrame() }
        }
        return { await self.removeConsumer(id, readsPixels: E.readsPixels) }
    }

    private func removeConsumer(
        _ id: UUID,
        readsPixels: Bool
    ) {
        guard consumers.removeValue(forKey: id) != nil else { return }
        if readsPixels { pixelConsumers.decrement() }
    }

    private func handleFrame(_ frame: Frame) {
        guard phase == .running else { return }
        screenSize = frame.pixelBuffer.dimensions
        for consumer in consumers.values {
            consumer.handleFrame(frame)
        }
    }

    /// Reports the screen size with the first frame after subscribing (at most
    /// one idle tick away) and whenever it changes, without encoding anything.
    func addSizeConsumer(
        onSize: sending @escaping (Dimensions) async -> Void
    ) -> (@Sendable () async -> Void) {
        var last: Dimensions?
        return addConsumer(encoder: SizeEncoder()) { size in
            guard size != last else { return }
            last = size
            await onSize(size)
        }
    }

    /// JPEG of the current screen, encoded on demand. Used to seed new viewers
    /// so the session doesn't JPEG-encode every frame just in case.
    func snapshotJPEG() async throws -> (Dimensions, Data)? {
        guard phase == .running, let pixelBuffer = await frameCapture.copyCurrentFrame() else { return nil }
        let frame = Frame(pixelBuffer: pixelBuffer)
        return (frame.pixelBuffer.dimensions, try await snapshotEncoder.encode(frame))
    }

    func addMJPEGConsumer(
        onFrame: sending @escaping (Dimensions, Data) async -> Void
    ) -> (@Sendable () async -> Void) {
        return addConsumer(encoder: mjpegEncoder, onFrame: { [weak self] data in
            guard let self else { return }
            await onFrame(screenSize, data)
        })
    }

    func addAVCCConsumer(
        onFrame: sending @escaping (Dimensions, Data, Int32) async -> Void
    ) -> (@Sendable () async -> Void) {
        addConsumer(encoder: AVCCEncoder(diagnostics: encoderDiagnostics, maxBitrate: maxBitrate)) { [weak self] encoded in
            let flagDescription: Int32 = 1 << 0
            let flagKeyframe: Int32 = 1 << 1

            guard let self, let encoded else { return }
            if let description = encoded.description {
                await onFrame(
                    screenSize,
                    AVCCEnvelope.description(avcc: description),
                    flagDescription,
                )
            }
            switch encoded.kind {
            case .keyframe:
                await onFrame(
                    screenSize,
                    AVCCEnvelope.keyframe(avcc: encoded.avcc),
                    flagKeyframe,
                )
            case .delta:
                await onFrame(
                    screenSize,
                    AVCCEnvelope.delta(avcc: encoded.avcc),
                    0,
                )
            }
        }
    }

    func stop() {
        if phase == .stopped { return }
        phase = .stopped
        Task { [frameCapture] in await frameCapture.stop() }
        consumers.removeAll()
        pixelConsumers.reset()
    }
}

struct SizeEncoder: FrameEncoder {
    static var readsPixels: Bool { false }
    func encode(_ frame: Frame) async throws -> Dimensions { frame.pixelBuffer.dimensions }
}

/// Lock-protected count shared by CaptureEngine (writer) and FrameCapture
/// (reader on its capture queue).
final class PixelConsumerCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.lock(); count += 1; lock.unlock() }
    func decrement() { lock.lock(); count = max(0, count - 1); lock.unlock() }
    func reset() { lock.lock(); count = 0; lock.unlock() }
    var isEmpty: Bool { lock.lock(); defer { lock.unlock() }; return count == 0 }
}

actor MJPEGEncoder: FrameEncoder {
    private let videoEncoder = VideoEncoder(quality: 0.7)
    private var lastImage: (UUID, Data)?

    init() {}

    func encode(_ frame: Frame) async throws -> Data {
        if let (id, data) = lastImage, id == frame.id { return data }
        let data = try await videoEncoder.encode(pixelBuffer: frame.pixelBuffer)
        lastImage = (frame.id, data)
        return data
    }
}

actor AVCCEncoder: FrameEncoder {
    private static let timeout: Duration = .milliseconds(500)

    let h264Encoder: H264Encoder
    var forceKeyframe = true

    init(diagnostics: EncoderDiagnostics? = nil, maxBitrate: Int? = nil) {
        h264Encoder = H264Encoder(fps: 60, maxBitrate: maxBitrate, diagnostics: diagnostics)
    }

    func encode(_ frame: Frame) async throws -> H264Encoder.Encoded? {
        // TODO: cancel after timeout using TaskGroup
        let result = try await h264Encoder.encode(
            frame.pixelBuffer,
            forceKeyframe: forceKeyframe,
        )
        if result != nil { forceKeyframe = false }
        return result
    }

    deinit {
        Task { [h264Encoder] in await h264Encoder.stop() }
    }
}
