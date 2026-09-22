import Foundation
import CoreGraphics
import zlib
import Accelerate

/// Lossless RGBA PNG with fast DEFLATE, avoiding ImageIO's archival compression.
enum FastPNG {
    static func encode(_ image: CGImage) throws -> Data {
        guard image.bitsPerPixel == 32, image.bitsPerComponent == 8,
              let data = image.dataProvider?.data else { throw CocoaError(.fileReadCorruptFile) }
        let width = image.width, height = image.height, rowSize = width * 4
        let source = CFDataGetBytePtr(data)!
        let premultiplied = image.alphaInfo == .premultipliedLast
        let inputStride = image.bytesPerRow
        // Core Image returns premultiplied RGBA. Accelerate unpremultiplies
        // whole rows with vector instructions before the PNG Sub filter.
        var straight = Data(count: premultiplied ? rowSize * height : 0)
        if premultiplied {
            let result = straight.withUnsafeMutableBytes { output in
                var input = vImage_Buffer(data: UnsafeMutableRawPointer(mutating: source), height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: inputStride)
                var destination = vImage_Buffer(data: output.baseAddress!, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: rowSize)
                return vImageUnpremultiplyData_RGBA8888(&input, &destination, vImage_Flags(kvImageNoFlags))
            }
            guard result == kvImageNoError else { throw CocoaError(.fileReadCorruptFile) }
        }
        var scanlines = Data(count: (rowSize + 1) * height)
        straight.withUnsafeBytes { straightBytes in
            let pixels = premultiplied ? straightBytes.bindMemory(to: UInt8.self).baseAddress! : source
            let stride = premultiplied ? rowSize : inputStride
            scanlines.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
                let output = bytes.bindMemory(to: UInt8.self).baseAddress!
                for y in 0..<height {
                    let row = output + y * (rowSize + 1)
                    row[0] = 1
                    let input = pixels + y * stride
                    let sourceRow = UnsafeRawPointer(input)
                    let destination = UnsafeMutableRawPointer(row + 1)
                    destination.storeBytes(of: sourceRow.loadUnaligned(as: UInt32.self), as: UInt32.self)
                    var offset = 4
                    while offset + 16 <= rowSize {
                        let current = sourceRow.loadUnaligned(fromByteOffset: offset, as: SIMD16<UInt8>.self)
                        let previous = sourceRow.loadUnaligned(fromByteOffset: offset - 4, as: SIMD16<UInt8>.self)
                        destination.storeBytes(of: current &- previous, toByteOffset: offset, as: SIMD16<UInt8>.self)
                        offset += 16
                    }
                    while offset < rowSize {
                        row[1 + offset] = input[offset] &- input[offset - 4]
                        offset += 1
                    }
                }
            }
        }
        // Independent raw-DEFLATE stripes run concurrently. Nonfinal stripes
        // end with a byte-aligned sync flush, so their blocks form one zlib
        // stream without retaining dictionary references across stripes.
        let stripeCount = height >= 128 ? 4 : 1
        let results = StripeResults(count: stripeCount)
        scanlines.withUnsafeBytes { source in
            DispatchQueue.concurrentPerform(iterations: stripeCount) { stripe in
                let firstRow = height * stripe / stripeCount
                let lastRow = height * (stripe + 1) / stripeCount
                let start = firstRow * (rowSize + 1), count = (lastRow - firstRow) * (rowSize + 1)
                results.store(Self.deflateStripe(UnsafeRawBufferPointer(rebasing: source[start..<(start + count)]),
                                                final: stripe == stripeCount - 1), at: stripe)
            }
        }
        guard results.stripes.allSatisfy({ $0 != nil }) else { throw CocoaError(.fileWriteUnknown) }
        var compressed = Data([0x78, 0x01])
        for stripe in results.stripes { compressed.append(stripe!) }
        let checksum = scanlines.withUnsafeBytes { adler32(1, $0.bindMemory(to: UInt8.self).baseAddress!, uInt($0.count)) }
        var bigEndianChecksum = UInt32(checksum).bigEndian
        compressed.append(Data(bytes: &bigEndianChecksum, count: 4))
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
    private final class StripeResults: @unchecked Sendable {
        private let lock = NSLock()
        private(set) var stripes: [Data?]
        init(count: Int) { stripes = Array(repeating: nil, count: count) }
        func store(_ value: Data?, at index: Int) {
            lock.lock(); defer { lock.unlock() }
            stripes[index] = value
        }
    }

    private static func deflateStripe(_ source: UnsafeRawBufferPointer, final: Bool) -> Data? {
        var stream = z_stream()
        guard deflateInit2_(&stream, Z_BEST_SPEED, Z_DEFLATED, -MAX_WBITS, 8, Z_DEFAULT_STRATEGY,
                           ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { return nil }
        defer { deflateEnd(&stream) }
        var output = Data(count: Int(deflateBound(&stream, uLong(source.count))) + 64)
        let result = output.withUnsafeMutableBytes { destination in
            stream.next_in = UnsafeMutablePointer(mutating: source.bindMemory(to: UInt8.self).baseAddress!)
            stream.avail_in = uInt(source.count)
            stream.next_out = destination.bindMemory(to: UInt8.self).baseAddress!
            stream.avail_out = uInt(destination.count)
            return deflate(&stream, final ? Z_FINISH : Z_SYNC_FLUSH)
        }
        guard result == (final ? Z_STREAM_END : Z_OK), stream.avail_in == 0, stream.avail_out > 0 else { return nil }
        output.count = Int(stream.total_out)
        return output
    }

}
