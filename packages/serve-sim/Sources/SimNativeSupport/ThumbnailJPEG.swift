import Accelerate
import CoreGraphics
import Foundation
import ImageIO

public struct ThumbnailSize: Equatable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

/// Small JPEG stills for the opt-in rolling frame buffer (`serve-sim buffer`).
///
/// A simulator framebuffer is large (1206x2622 BGRA on an iPhone 17 Pro,
/// ~12.6 MB); a JPEG of it is ~150-400 KB. The buffer keeps up to a minute
/// of history, so frames are downscaled on the long edge before encoding.
public enum ThumbnailJPEG {
    public enum Errors: Error, CustomStringConvertible {
        case emptySource
        case scaleFailed(Int)
        case encodingFailed

        public var description: String {
            switch self {
            case .emptySource: return "thumbnail source is empty"
            case .scaleFailed(let code): return "thumbnail scale failed (vImage \(code))"
            case .encodingFailed: return "thumbnail JPEG encoding failed"
            }
        }
    }

    /// `width`x`height` fitted so the long edge is at most `maxDimension`,
    /// keeping the aspect ratio, never upscaling, at least 1 px per side.
    /// Zero for non-positive inputs.
    public static func fit(width: Int, height: Int, maxDimension: Int) -> ThumbnailSize {
        guard width > 0, height > 0, maxDimension > 0 else { return ThumbnailSize(width: 0, height: 0) }
        let longEdge = max(width, height)
        if longEdge <= maxDimension { return ThumbnailSize(width: width, height: height) }
        let scale = Double(maxDimension) / Double(longEdge)
        return ThumbnailSize(
            width: max(1, Int((Double(width) * scale).rounded())),
            height: max(1, Int((Double(height) * scale).rounded()))
        )
    }

    /// Downscale a BGRA (premultiplied-first, little-endian: the simulator
    /// framebuffer layout) image to fit `maxDimension` and encode it as JPEG.
    /// The source is only read.
    public static func encode(
        bgra base: UnsafeRawPointer,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        maxDimension: Int,
        quality: Double
    ) throws -> (size: ThumbnailSize, data: Data) {
        let size = fit(width: width, height: height, maxDimension: maxDimension)
        guard size.width > 0, size.height > 0, bytesPerRow >= width * 4 else { throw Errors.emptySource }

        let outRowBytes = size.width * 4
        var scaled = [UInt8](repeating: 0, count: outRowBytes * size.height)
        try scaled.withUnsafeMutableBytes { out in
            if size.width == width, size.height == height {
                for row in 0..<height {
                    memcpy(out.baseAddress! + row * outRowBytes, base + row * bytesPerRow, outRowBytes)
                }
                return
            }
            var src = vImage_Buffer(
                data: UnsafeMutableRawPointer(mutating: base),
                height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: bytesPerRow
            )
            var dst = vImage_Buffer(
                data: out.baseAddress!,
                height: vImagePixelCount(size.height), width: vImagePixelCount(size.width), rowBytes: outRowBytes
            )
            // Channel order doesn't matter to the resampler; default (Lanczos3)
            // keeps small UI text legible at 1/4 scale.
            let error = vImageScale_ARGB8888(&src, &dst, nil, vImage_Flags(kvImageNoFlags))
            if error != kvImageNoError { throw Errors.scaleFailed(error) }
        }

        let data = NSMutableData()
        let encoded: Bool = scaled.withUnsafeMutableBytes { out in
            guard let context = CGContext(
                data: out.baseAddress,
                width: size.width,
                height: size.height,
                bitsPerComponent: 8,
                bytesPerRow: outRowBytes,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
            ), let image = context.makeImage(),
                let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil)
            else { return false }
            CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            return CGImageDestinationFinalize(dest)
        }
        guard encoded else { throw Errors.encodingFailed }
        return (size, data as Data)
    }
}
