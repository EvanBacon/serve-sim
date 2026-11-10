import AVFoundation
import CoreGraphics
import Foundation

/// Offline reads of a finished `serve-sim record` MP4 (or any local movie)
/// for `serve-sim record frame|diff`: the video track's sample times without
/// decoding, and one decoded frame as RGBA pixels. Read-only; never touches
/// the recorder.
public enum RecordingFrameReader {
    public enum ReadError: Error, CustomStringConvertible {
        case noVideoTrack(String)
        case unreadable(String, String)
        case decodeFailed(String, Double, String)

        public var description: String {
            switch self {
            case .noVideoTrack(let path): return "\(path) has no video track"
            case .unreadable(let path, let reason): return "Could not read \(path): \(reason)"
            case .decodeFailed(let path, let seconds, let reason):
                return "Could not decode the frame at \(seconds)s of \(path): \(reason)"
            }
        }
    }

    public struct Info: Sendable {
        /// Container duration, seconds.
        public let duration: Double
        /// Displayed size (track transform applied), pixels.
        public let width: Int
        public let height: Int
        /// Presentation time of every video sample, ascending, seconds.
        public let sampleTimes: [Double]

        public func jsonObject() -> [String: Any] {
            ["duration": duration, "width": width, "height": height, "sampleTimes": sampleTimes]
        }
    }

    public struct Frame: Sendable {
        public let width: Int
        public let height: Int
        /// Presentation time of the decoded sample, seconds.
        public let time: Double
        /// Tightly packed 8-bit RGBA (alpha 255), row-major, top row first.
        public let rgba: Data
    }

    private static func videoTrack(_ asset: AVURLAsset, _ path: String) async throws -> AVAssetTrack {
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .video)
        } catch {
            throw ReadError.unreadable(path, error.localizedDescription)
        }
        guard let track = tracks.first else { throw ReadError.noVideoTrack(path) }
        return track
    }

    /// Duration, displayed size, and sample times. Sample buffers are read
    /// compressed (no decode), so this is cheap even for long recordings.
    public static func info(path: String) async throws -> Info {
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let track = try await videoTrack(asset, path)
        let (duration, size, transform, segments) = try await (
            asset.load(.duration), track.load(.naturalSize), track.load(.preferredTransform), track.load(.segments)
        )
        let shown = size.applying(transform)

        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: asset)
        } catch {
            throw ReadError.unreadable(path, error.localizedDescription)
        }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output)
        guard reader.startReading() else {
            throw ReadError.unreadable(path, reader.error?.localizedDescription ?? "reader did not start")
        }
        var times: [Double] = []
        while let sample = output.copyNextSampleBuffer() {
            // Skip empty marker buffers (no media data).
            guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(sample)
            if pts.isValid, let shownAt = presentationTime(pts, segments) { times.append(shownAt) }
        }
        if reader.status == .failed {
            throw ReadError.unreadable(path, reader.error?.localizedDescription ?? "read failed")
        }
        times.sort()
        return Info(
            duration: duration.seconds,
            width: Int(abs(shown.width).rounded()),
            height: Int(abs(shown.height).rounded()),
            sampleTimes: times
        )
    }

    /// Sample buffers carry media-timeline times; the edit list (track
    /// segments) maps them to the presentation timeline the image generator
    /// and players use. Samples outside every segment are never shown (nil).
    static func presentationTime(_ mediaTime: CMTime, _ segments: [AVAssetTrackSegment]) -> Double? {
        if segments.isEmpty { return mediaTime.seconds }
        for segment in segments where !segment.isEmpty {
            let mapping = segment.timeMapping
            let source = mapping.source
            guard source.containsTime(mediaTime) else { continue }
            let rate = mapping.target.duration.seconds / max(source.duration.seconds, .leastNonzeroMagnitude)
            return mapping.target.start.seconds + (mediaTime.seconds - source.start.seconds) * rate
        }
        return nil
    }

    /// Decode the sample shown at `seconds` exactly (zero tolerance), with
    /// the track transform applied, as RGBA.
    public static func frame(path: String, seconds: Double) async throws -> Frame {
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        _ = try await videoTrack(asset, path)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let image: CGImage
        let actual: CMTime
        do {
            (image, actual) = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600_000))
        } catch {
            throw ReadError.decodeFailed(path, seconds, error.localizedDescription)
        }
        let width = image.width
        let height = image.height
        var data = Data(count: width * height * 4)
        let drawn = data.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(
                data: raw.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                // Keep the frame's own RGB space: converting to sRGB would
                // shift colors and make "unchanged" pixels look different.
                space: image.colorSpace.flatMap { $0.model == .rgb ? $0 : nil }
                    ?? CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { throw ReadError.decodeFailed(path, seconds, "could not create a bitmap context") }
        // noneSkipLast leaves the fourth byte undefined; make it opaque.
        data.withUnsafeMutableBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            var i = 3
            while i < bytes.count {
                bytes[i] = 255
                i += 4
            }
        }
        return Frame(width: width, height: height, time: actual.seconds, rgba: data)
    }
}
