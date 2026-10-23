import Foundation
import AVFoundation
import CoreMedia
import CoreVideo
import SimNativeSupport

/// Records the captured simulator screen straight to an MP4 with
/// AVAssetWriter (VideoToolbox hardware H.264/HEVC).
///
/// Frames are the private BGRA copies FrameCapture already makes for the live
/// encoders: full native resolution, no MJPEG/stream re-encode, no scaling.
/// Each frame is placed on a constant `fps` grid by its capture time
/// (`RecordingFrameScheduler`), repeating the previous frame across static
/// stretches, so the file is true CFR whose motion timing follows the
/// simulator rather than the encoder or JS event loop. Static slots are filled
/// as time passes by a frame-interval timer on `queue` that never waits on the
/// encoder, so the first frames of new motion don't queue up behind seconds of
/// repeats (and get shed by the backlog cap).
///
/// All writer state is confined to `queue`. `handleFrame` only enqueues, so a
/// slow encoder never stalls capture or the live stream consumers; the
/// backlog is capped (`maxPendingFrames`) so a stalled encoder can't pin an
/// unbounded number of full-resolution buffers.
final class ScreenRecorder: CaptureConsuming, @unchecked Sendable {
    struct Options {
        var path: String
        var codec: AVVideoCodecType = .h264
        var fps: Int = 60
        /// Clockwise display rotation (0, 90, 180, 270/-90) stored as the
        /// track transform. The framebuffer itself is always native portrait.
        var rotationDegrees: Int = 0
        /// Average bitrate (bits/s); nil scales with the pixel rate.
        var bitrate: Int?
    }

    enum Errors: Error, CustomStringConvertible {
        case noFrames
        case writerFailed(String)

        var description: String {
            switch self {
            case .noFrames: return "No frames were captured"
            case .writerFailed(let message): return "Recording failed: \(message)"
            }
        }
    }

    /// ~200 ms at 60 fps; each pending frame holds a full-res BGRA copy.
    static let maxPendingFrames = 12

    private let queue = DispatchQueue(label: "screen-recorder", qos: .userInitiated)
    private let pendingFrames = PendingFrameLimiter(limit: ScreenRecorder.maxPendingFrames)
    private let options: Options
    private let startedAt = Date()

    // queue-confined
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var scheduler: RecordingFrameScheduler
    private var dimensions: Dimensions?
    private var lastBuffer: CVPixelBuffer?
    private var fillTimer: DispatchSourceTimer?
    private var bitrate = 0
    private var finished = false
    private var failure: String?
    private var captured = 0
    private var encoded = 0
    private var repeated = 0
    private var dropped = 0
    private var encoderBusy = 0

    init(options: Options) {
        self.options = options
        self.scheduler = RecordingFrameScheduler(fps: options.fps)
    }

    func handleFrame(_ frame: Frame) {
        guard frame.isPrivateCopy else { return }
        // Over the cap the frame is dropped here (counted in `backlogDropped`);
        // the CFR scheduler repeats the previous frame across the gap.
        guard pendingFrames.tryAcquire() else { return }
        queue.async {
            defer { self.pendingFrames.release() }
            self.append(frame)
        }
    }

    /// Pad to "now", close the file, and return a JSON summary.
    func finish() async throws -> String {
        let stopTime = Self.now()
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.finish(at: stopTime) { result in continuation.resume(with: result) }
            }
        }
    }

    /// Abandon the recording and remove the partial file.
    func cancel() {
        queue.async {
            self.finished = true
            self.stopFillTimer()
            if let writer = self.writer, writer.status == .writing { writer.cancelWriting() }
            try? FileManager.default.removeItem(atPath: self.options.path)
        }
    }

    // MARK: - queue

    private func append(_ frame: Frame) {
        guard !finished, failure == nil else { return }
        captured += 1
        let size = frame.pixelBuffer.dimensions
        if let dimensions {
            // A mid-recording size change (Duo panel switch, Device Hub
            // resize) can't go in the same track; keep the original size.
            guard size == dimensions else { dropped += 1; return }
        } else {
            do { try startWriter(size) } catch {
                failure = String(describing: error)
                return
            }
        }
        guard let placement = scheduler.place(captureTime: frame.captureTime) else {
            dropped += 1
            return
        }
        // Normally empty: the fill timer already covered the static stretch.
        if let lastBuffer {
            for slot in placement.repeats where write(lastBuffer, slot: slot) { repeated += 1 }
        }
        if write(frame.pixelBuffer, slot: placement.slot) { encoded += 1 }
        lastBuffer = frame.pixelBuffer
    }

    private func startWriter(_ size: Dimensions) throws {
        let url = URL(fileURLWithPath: options.path)
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        // moov up front so browsers can play the download progressively.
        writer.shouldOptimizeForNetworkUse = true
        let bitrate = options.bitrate ?? RecordingBitrate.average(
            width: size.width, height: size.height, fps: options.fps
        )
        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoExpectedSourceFrameRateKey: options.fps,
            AVVideoMaxKeyFrameIntervalKey: options.fps * 2,
            AVVideoAllowFrameReorderingKey: true,
        ]
        if options.codec == .h264 {
            compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
        }
        let settings: [String: Any] = [
            AVVideoCodecKey: options.codec,
            AVVideoWidthKey: size.width,
            AVVideoHeightKey: size.height,
            AVVideoCompressionPropertiesKey: compression,
            // The simulator renders Display P3 with the sRGB curve; tag the
            // file the same way `simctl io recordVideo` does so colors match.
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_P3_D65,
                // AVVideoTransferFunction_IEC_sRGB (macOS 15+ symbol; same value).
                AVVideoTransferFunctionKey: "IEC_sRGB",
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        input.transform = Self.transform(rotationDegrees: options.rotationDegrees)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: size.width,
                kCVPixelBufferHeightKey as String: size.height,
            ]
        )
        guard writer.canAdd(input) else { throw Errors.writerFailed("cannot add video input") }
        writer.add(input)
        guard writer.startWriting() else {
            throw Errors.writerFailed(writer.error.map { String(describing: $0) } ?? "startWriting failed")
        }
        writer.startSession(atSourceTime: .zero)
        self.writer = writer
        self.input = input
        self.adaptor = adaptor
        self.dimensions = size
        self.bitrate = bitrate
        startFillTimer()
        print("[record] Recording \(size.width)x\(size.height) @ \(options.fps) fps \(options.codec.rawValue) \(bitrate / 1000) kbps -> \(options.path)")
    }

    private static func now() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1e9
    }

    private func startFillTimer() {
        let interval = DispatchTimeInterval.nanoseconds(Int(1_000_000_000 / options.fps))
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in self?.fillStaticSlots() }
        timer.resume()
        fillTimer = timer
    }

    private func stopFillTimer() {
        fillTimer?.cancel()
        fillTimer = nil
    }

    /// Repeat the last frame into the slots that have gone by with no new
    /// frame. Usually one slot per tick. Never waits on the encoder: a slot it
    /// can't write yet stays owed to the next tick (or the next frame's
    /// placement), so the queue stays free for captured frames. Skipped while
    /// frames wait behind a slow encoder: their slots must stay open.
    private func fillStaticSlots() {
        guard !finished, failure == nil, let lastBuffer else { return }
        for slot in scheduler.repeatsDue(at: Self.now(), framesPending: pendingFrames.pending) {
            guard write(lastBuffer, slot: slot, waitForEncoder: false) else { break }
            scheduler.didFill(through: slot)
            repeated += 1
        }
    }

    @discardableResult
    private func write(_ buffer: CVPixelBuffer, slot: Int64, waitForEncoder: Bool = true) -> Bool {
        guard let writer, let input, let adaptor, failure == nil else { return false }
        // We're on the recorder's own queue, so waiting here only delays the
        // recording, never capture or the live stream. Real-time inputs may
        // briefly refuse data while the hardware encoder catches up.
        var waitedMs = 0
        while waitForEncoder, !input.isReadyForMoreMediaData, waitedMs < 250, writer.status == .writing {
            usleep(1000)
            waitedMs += 1
        }
        guard input.isReadyForMoreMediaData else {
            if waitForEncoder { encoderBusy += 1 }
            return false
        }
        let pts = CMTime(value: slot, timescale: CMTimeScale(options.fps))
        guard adaptor.append(buffer, withPresentationTime: pts) else {
            failure = writer.error.map { String(describing: $0) } ?? "append failed"
            return false
        }
        return true
    }

    private func finish(at stopTime: Double, completion: @escaping (Result<String, Error>) -> Void) {
        guard !finished else { return completion(.failure(Errors.writerFailed("already finished"))) }
        finished = true
        stopFillTimer()
        guard let writer, let input, let lastBuffer, let end = scheduler.finish(at: stopTime) else {
            if let writer, writer.status == .writing { writer.cancelWriting() }
            try? FileManager.default.removeItem(atPath: options.path)
            return completion(.failure(failure.map(Errors.writerFailed) ?? Errors.noFrames))
        }
        for slot in end.repeats where write(lastBuffer, slot: slot) { repeated += 1 }
        input.markAsFinished()
        let fps = options.fps
        writer.endSession(atSourceTime: CMTime(value: end.endSlot, timescale: CMTimeScale(fps)))
        let summary: [String: Any] = [
            "path": options.path,
            "width": dimensions?.width ?? 0,
            "height": dimensions?.height ?? 0,
            "fps": fps,
            "codec": options.codec == .hevc ? "hevc" : "h264",
            "bitrate": bitrate,
            "rotation": options.rotationDegrees,
            "frames": Int(end.endSlot),
            "duration": Double(end.endSlot) / Double(fps),
            "captured": captured,
            "encoded": encoded,
            "repeated": repeated,
            "dropped": dropped + pendingFrames.dropped,
            "backlogDropped": pendingFrames.dropped,
            "encoderBusy": encoderBusy,
            "startedAt": isoTimestamp(startedAt),
        ]
        writer.finishWriting {
            if writer.status == .completed {
                print("[record] Saved \(self.options.path) (\(summary["frames"] ?? 0) frames, \(self.captured) captured, \(self.repeated) repeated, \(self.dropped + self.pendingFrames.dropped) dropped)")
                completion(.success(jsonString(summary)))
            } else {
                let message = writer.error.map { String(describing: $0) } ?? "status \(writer.status.rawValue)"
                completion(.failure(Errors.writerFailed(message)))
            }
        }
    }

    private static func transform(rotationDegrees: Int) -> CGAffineTransform {
        switch ((rotationDegrees % 360) + 360) % 360 {
        case 90: return CGAffineTransform(rotationAngle: .pi / 2)
        case 180: return CGAffineTransform(rotationAngle: .pi)
        case 270: return CGAffineTransform(rotationAngle: -.pi / 2)
        default: return .identity
        }
    }
}
