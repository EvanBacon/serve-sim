import Foundation
import CoreGraphics
import zlib

/// Lossless RGBA PNG with fast DEFLATE, avoiding ImageIO's archival compression.
enum FastPNG {
    static func encode(_ image: CGImage) throws -> Data {
        guard image.bitsPerPixel == 32, image.bitsPerComponent == 8,
              let data = image.dataProvider?.data else { throw CocoaError(.fileReadCorruptFile) }
        let width = image.width, height = image.height, rowSize = width * 4
        let source = CFDataGetBytePtr(data)!
        let premultiplied = image.alphaInfo == .premultipliedLast
        let inputStride = image.bytesPerRow
        var scanlines = Data(count: (rowSize + 1) * height)
        scanlines.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
            let output = bytes.bindMemory(to: UInt8.self).baseAddress!
            for y in 0..<height {
                let row = output + y * (rowSize + 1)
                row[0] = 1 // PNG Sub filter; adjacent pixels compress cheaply.
                let input = source + y * inputStride
                var previous = SIMD4<UInt8>(repeating: 0)
                for x in 0..<width {
                    let offset = x * 4
                    let alpha = input[offset + 3]
                    var pixel = SIMD4<UInt8>(input[offset], input[offset + 1], input[offset + 2], alpha)
                    if premultiplied && alpha > 0 && alpha < 255 {
                        for channel in 0..<3 { pixel[channel] = UInt8(min(255, (Int(pixel[channel]) * 255 + Int(alpha) / 2) / Int(alpha))) }
                    }
                    for channel in 0..<4 { row[1 + offset + channel] = pixel[channel] &- previous[channel] }
                    previous = pixel
                }
            }
        }
        var length = compressBound(uLong(scanlines.count))
        var compressed = Data(count: Int(length))
        let result = compressed.withUnsafeMutableBytes { destination in
            scanlines.withUnsafeBytes { source in
                compress2(destination.bindMemory(to: UInt8.self).baseAddress!, &length,
                          source.bindMemory(to: UInt8.self).baseAddress!, uLong(scanlines.count), Z_BEST_SPEED)
            }
        }
        guard result == Z_OK else { throw CocoaError(.fileWriteUnknown) }
        compressed.count = Int(length)
        var png = Data([137, 80, 78, 71, 13, 10, 26, 10])
        func integer(_ value: Int) -> Data {
            var bigEndian = UInt32(value).bigEndian
            return Data(bytes: &bigEndian, count: 4)
        }
        func chunk(_ name: String, _ contents: Data) {
            let body = Data(name.utf8) + contents
            png.append(integer(contents.count))
            png.append(body)
            let crc = body.withUnsafeBytes { crc32(0, $0.bindMemory(to: UInt8.self).baseAddress!, uInt(body.count)) }
            png.append(integer(Int(crc)))
        }
        chunk("IHDR", integer(width) + integer(height) + Data([8, 6, 0, 0, 0]))
        chunk("sRGB", Data([0]))
        chunk("IDAT", compressed)
        chunk("IEND", Data())
        return png
    }
}
