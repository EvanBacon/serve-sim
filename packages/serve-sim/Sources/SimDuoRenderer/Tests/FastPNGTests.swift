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
        print("FastPNG: opaque, translucent, transparent and premultiplied RGBA round-trips passed")
    }
}
