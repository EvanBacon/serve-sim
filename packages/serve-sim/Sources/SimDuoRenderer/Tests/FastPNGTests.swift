import Foundation
import CoreGraphics
import ImageIO

@main enum FastPNGTests {
    static func main() throws {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        for alpha in [CGImageAlphaInfo.last, .premultipliedLast] {
            let bytes: [UInt8] = alpha == .last
                ? [255, 0, 0, 255, 0, 122, 255, 255, 255, 0, 0, 128, 0, 0, 0, 0]
                : [255, 0, 0, 255, 0, 122, 255, 255, 128, 0, 0, 128, 0, 0, 0, 0]
            let original = CGImage(width: 4, height: 1, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 16, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: alpha.rawValue), provider: CGDataProvider(data: Data(bytes) as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
            let png = try FastPNG.encode(original)
            let source = CGImageSourceCreateWithData(png as CFData, nil)!
            guard let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fatalError("Invalid PNG/CRC") }
            precondition(decoded.width == 4 && decoded.height == 1)
            func canonical(_ image: CGImage) -> [UInt8] {
                var output = [UInt8](repeating: 0, count: 16)
                output.withUnsafeMutableBytes { buffer in
                    let context = CGContext(data: buffer.baseAddress!, width: 4, height: 1, bitsPerComponent: 8, bytesPerRow: 16, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                    context.draw(image, in: CGRect(x: 0, y: 0, width: 4, height: 1))
                }
                return output
            }
            let expected = canonical(original), actual = canonical(decoded)
            precondition(zip(expected, actual).allSatisfy { abs(Int($0) - Int($1)) <= 1 }, "RGBA round-trip changed color or alpha")
        }
        // Cross vector boundaries and padded row strides with varying RGBA.
        for (width, alpha) in [1, 4, 5, 17, 64, 1500].flatMap({ width in
            [CGImageAlphaInfo.last, .premultipliedLast].map { (width, $0) }
        }) {
            let height = width >= 17 ? 257 : 3, stride = width * 4 + 12
            var bytes = (0..<(stride * height)).map { UInt8(($0 * 73 + 19) % 256) }
            if alpha == .premultipliedLast {
                for y in 0..<height { for x in 0..<width {
                    let offset = y * stride + x * 4
                    for channel in 0..<3 { bytes[offset + channel] = UInt8(Int(bytes[offset + channel]) * Int(bytes[offset + 3]) / 255) }
                } }
            }
            let original = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: stride, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: alpha.rawValue), provider: CGDataProvider(data: Data(bytes) as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
            let png = try FastPNG.encode(original)
            let decoded = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(png as CFData, nil)!, 0, nil)!
            func pixels(_ image: CGImage) -> [UInt8] {
                var output = [UInt8](repeating: 0, count: width * height * 4)
                output.withUnsafeMutableBytes { buffer in
                    let context = CGContext(data: buffer.baseAddress!, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                }
                return output
            }
            precondition(zip(pixels(original), pixels(decoded)).allSatisfy { abs(Int($0) - Int($1)) <= 1 }, "Vector PNG filter changed RGBA pixels")
        }
        print("FastPNG: opaque, translucent, transparent and premultiplied RGBA round-trips passed")
    }
}
