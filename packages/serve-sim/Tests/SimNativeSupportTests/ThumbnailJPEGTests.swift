import Foundation
import ImageIO
import XCTest
@testable import SimNativeSupport

final class ThumbnailJPEGFitTests: XCTestCase {
    func testFitsTheLongEdgeAndKeepsAspect() {
        // iPhone 17 Pro portrait framebuffer.
        XCTAssertEqual(ThumbnailJPEG.fit(width: 1206, height: 2622, maxDimension: 640), ThumbnailSize(width: 294, height: 640))
        XCTAssertEqual(ThumbnailJPEG.fit(width: 2622, height: 1206, maxDimension: 640), ThumbnailSize(width: 640, height: 294))
    }

    func testNeverUpscales() {
        XCTAssertEqual(ThumbnailJPEG.fit(width: 300, height: 200, maxDimension: 640), ThumbnailSize(width: 300, height: 200))
    }

    func testKeepsAtLeastOnePixel() {
        XCTAssertEqual(ThumbnailJPEG.fit(width: 4000, height: 2, maxDimension: 100), ThumbnailSize(width: 100, height: 1))
    }

    func testNonPositiveInputsGiveZero() {
        XCTAssertEqual(ThumbnailJPEG.fit(width: 0, height: 10, maxDimension: 640), ThumbnailSize(width: 0, height: 0))
        XCTAssertEqual(ThumbnailJPEG.fit(width: 10, height: 10, maxDimension: 0), ThumbnailSize(width: 0, height: 0))
    }
}

final class ThumbnailJPEGEncodeTests: XCTestCase {
    /// BGRA buffer, padded rows like a real IOSurface: top half red, bottom half blue.
    private func makeSource(width: Int, height: Int, padding: Int = 64) -> (bytes: [UInt8], bytesPerRow: Int) {
        let bytesPerRow = width * 4 + padding
        var bytes = [UInt8](repeating: 0, count: bytesPerRow * height)
        for y in 0..<height {
            for x in 0..<width {
                let o = y * bytesPerRow + x * 4
                let red = y < height / 2
                bytes[o] = red ? 0 : 255   // B
                bytes[o + 1] = 0           // G
                bytes[o + 2] = red ? 255 : 0 // R
                bytes[o + 3] = 255         // A
            }
        }
        return (bytes, bytesPerRow)
    }

    private func decode(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    /// RGBA of one decoded pixel.
    private func pixel(_ image: CGImage, x: Int, y: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: 4)
        let context = CGContext(
            data: &out, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        return out
    }

    func testDownscalesToTheFittedSizeAsJPEG() throws {
        let (bytes, bytesPerRow) = makeSource(width: 1206, height: 2622)
        let result = try bytes.withUnsafeBytes { raw in
            try ThumbnailJPEG.encode(bgra: raw.baseAddress!, width: 1206, height: 2622, bytesPerRow: bytesPerRow, maxDimension: 640, quality: 0.6)
        }
        XCTAssertEqual(result.size, ThumbnailSize(width: 294, height: 640))
        XCTAssertEqual(Array(result.data.prefix(2)), [0xFF, 0xD8], "JPEG SOI")
        let image = try XCTUnwrap(decode(result.data))
        XCTAssertEqual(image.width, 294)
        XCTAssertEqual(image.height, 640)
        // Channel order survives the scale: red stays red (top), blue stays blue (bottom).
        let top = pixel(image, x: 147, y: 80)
        let bottom = pixel(image, x: 147, y: 560)
        XCTAssertGreaterThan(top[0], 200); XCTAssertLessThan(top[2], 60)
        XCTAssertGreaterThan(bottom[2], 200); XCTAssertLessThan(bottom[0], 60)
        // Small: a flat two-colour frame at this size is a few KB.
        XCTAssertLessThan(result.data.count, 20_000)
    }

    func testASmallSourceIsEncodedAtItsOwnSize() throws {
        let (bytes, bytesPerRow) = makeSource(width: 100, height: 60)
        let result = try bytes.withUnsafeBytes { raw in
            try ThumbnailJPEG.encode(bgra: raw.baseAddress!, width: 100, height: 60, bytesPerRow: bytesPerRow, maxDimension: 640, quality: 0.6)
        }
        XCTAssertEqual(result.size, ThumbnailSize(width: 100, height: 60))
        let image = try XCTUnwrap(decode(result.data))
        XCTAssertEqual(image.width, 100)
    }

    func testLowerQualityIsSmaller() throws {
        // Noise compresses poorly, so quality shows in the size.
        let width = 400, height = 400, bytesPerRow = width * 4
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<(bytesPerRow * height)).map { _ in UInt8.random(in: 0...255, using: &generator) }
        func size(_ quality: Double) throws -> Int {
            try bytes.withUnsafeBytes { raw in
                try ThumbnailJPEG.encode(bgra: raw.baseAddress!, width: width, height: height, bytesPerRow: bytesPerRow, maxDimension: 400, quality: quality).data.count
            }
        }
        XCTAssertLessThan(try size(0.3), try size(0.9))
    }

    func testRejectsAnEmptySource() {
        let bytes = [UInt8](repeating: 0, count: 16)
        XCTAssertThrowsError(try bytes.withUnsafeBytes { raw in
            try ThumbnailJPEG.encode(bgra: raw.baseAddress!, width: 0, height: 0, bytesPerRow: 0, maxDimension: 640, quality: 0.6)
        })
    }
}
