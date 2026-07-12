import Foundation
import CoreVideo
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Encodes CVPixelBuffer frames as JPEG data for MJPEG streaming.
final class VideoEncoder {
    private var onEncodedFrame: ((Data) -> Void)?
    private let quality: CGFloat
    private let maxDimension: Int
    private(set) var outputWidth: Int = 0
    private(set) var outputHeight: Int = 0

    init(quality: CGFloat = 0.7, maxDimension: Int = 0) {
        self.quality = quality
        self.maxDimension = max(0, maxDimension)
    }

    func setup(width: Int32, height: Int32, fps: Int,
               onEncodedFrame: @escaping (Data) -> Void) {
        self.onEncodedFrame = onEncodedFrame
        let dims = scaledDimensions(width: Int(width), height: Int(height))
        outputWidth = dims.width
        outputHeight = dims.height
        let scaleNote = maxDimension > 0
            ? ", maxDimension: \(maxDimension), output: \(outputWidth)x\(outputHeight)"
            : ""
        print("[encoder] JPEG encoder ready at \(width)x\(height) (quality: \(quality)\(scaleNote))")
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

        let imageToEncode = scaledImageIfNeeded(cgImage) ?? cgImage
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, imageToEncode, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return }

        onEncodedFrame?(data as Data)
    }

    private func scaledDimensions(width: Int, height: Int) -> (width: Int, height: Int) {
        guard maxDimension > 0 else { return (width, height) }
        let largest = max(width, height)
        guard largest > maxDimension else { return (width, height) }
        let scale = Double(maxDimension) / Double(largest)
        return (
            max(1, Int((Double(width) * scale).rounded())),
            max(1, Int((Double(height) * scale).rounded()))
        )
    }

    private func scaledImageIfNeeded(_ image: CGImage) -> CGImage? {
        let dims = scaledDimensions(width: image.width, height: image.height)
        guard dims.width != image.width || dims.height != image.height else { return nil }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: dims.width,
            height: dims.height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        ) else { return nil }

        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: dims.width, height: dims.height))
        return context.makeImage()
    }

    func stop() {
        onEncodedFrame = nil
    }
}
