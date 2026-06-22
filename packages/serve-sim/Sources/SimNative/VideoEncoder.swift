import Foundation
import CoreVideo
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Encodes CVPixelBuffer frames as JPEG data for MJPEG streaming.
final class VideoEncoder {
    private var onEncodedFrame: ((Data) -> Void)?
    private let quality: CGFloat

    init(quality: CGFloat = 0.7) {
        self.quality = quality
    }

    func setup(width: Int32, height: Int32, fps: Int,
               onEncodedFrame: @escaping (Data) -> Void) {
        self.onEncodedFrame = onEncodedFrame
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

        onEncodedFrame?(data as Data)
    }

    func stop() {
        onEncodedFrame = nil
    }
}
