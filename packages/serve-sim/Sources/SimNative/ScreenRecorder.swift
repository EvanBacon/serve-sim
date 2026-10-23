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
/// simulator rather than the encoder or JS event loop.
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
        let stopTime = Double(DispatchTime.now().uptimeNanoseconds) / 1e9
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
        print("[record] Recording \(size.width)x\(size.height) @ \(options.fps) fps \(options.codec.rawValue) \(bitrate / 1000) kbps -> \(options.path)")
    }

    @discardableResult
    private func write(_ buffer: CVPixelBuffer, slot: Int64) -> Bool {
        guard let writer, let input, let adaptor, failure == nil else { return false }
        // We're on the recorder's own queue, so waiting here only delays the
        // recording, never capture or the live stream. Real-time inputs may
        // briefly refuse data while the hardware encoder catches up.
        var waitedMs = 0
        while !input.isReadyForMoreMediaData, waitedMs < 250, writer.status == .writing {
            usleep(1000)
            waitedMs += 1
        }
        guard input.isReadyForMoreMediaData else {
            encoderBusy += 1
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
