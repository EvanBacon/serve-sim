import Foundation
import CoreVideo
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Encodes CVPixelBuffer frames as JPEG data for MJPEG streaming.
final class VideoEncoder {
    private var onEncodedFrame: ((Data) -> Void)?
    // Guards onEncodedFrame: setup()/stop() run on the capture queue (a
    // resolution change swaps the closure), while encode() reads it on the
    // encode queue. Without this lock the swap races the read and double-frees
    // the old closure's context — heap corruption under macOS 26's allocator.
    private let cbLock = NSLock()
    private let quality: CGFloat

    init(quality: CGFloat = 0.7) {
        self.quality = quality
    }

    func setup(width: Int32, height: Int32, fps: Int,
               onEncodedFrame: @escaping (Data) -> Void) {
        cbLock.lock()
        self.onEncodedFrame = onEncodedFrame
        cbLock.unlock()
        print("[encoder] JPEG encoder ready at \(width)x\(height) (quality: \(quality))")
    }

    func encode(pixelBuffer: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        ), let cgImage = context.makeImage() else { return }

        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, cgImage, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return }

        cbLock.lock()
        let callback = onEncodedFrame
        cbLock.unlock()
        callback?(data as Data)
    }

    func stop() {
        cbLock.lock()
        onEncodedFrame = nil
        cbLock.unlock()
    }
}
