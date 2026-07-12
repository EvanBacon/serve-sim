import CoreVideo

struct Dimensions: Hashable, Sendable {
    var width: Int
    var height: Int
}

extension CVPixelBuffer {
    var dimensions: Dimensions {
        Dimensions(width: CVPixelBufferGetWidth(self), height: CVPixelBufferGetHeight(self))
    }
}

struct Photocopier {
    private var _pool: CVPixelBufferPool?
    private var dimensions: Dimensions?

    init() {}

    private mutating func pool(dimensions: Dimensions) -> CVPixelBufferPool? {
        if let _pool, self.dimensions == dimensions {
            return _pool
        }
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(dimensions.width),
            kCVPixelBufferHeightKey as String: Int(dimensions.height),
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var newPool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &newPool)
        self._pool = newPool
        self.dimensions = dimensions
        return newPool
    }

    /// Deep-copy `source` (which wraps the recycled framebuffer IOSurface)
    /// into a private pooled buffer that sinks can retain.
    mutating func copy(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        guard let pool = self.pool(dimensions: source.dimensions) else { return nil }
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out) == kCVReturnSuccess,
              let dst = out else { return nil }

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        guard let srcAddr = CVPixelBufferGetBaseAddress(source),
              let dstAddr = CVPixelBufferGetBaseAddress(dst) else { return nil }
        let srcStride = CVPixelBufferGetBytesPerRow(source)
        let dstStride = CVPixelBufferGetBytesPerRow(dst)
        let rows = CVPixelBufferGetHeight(source)
        let copyBytes = min(srcStride, dstStride)
        for row in 0..<rows {
            memcpy(dstAddr + row * dstStride, srcAddr + row * srcStride, copyBytes)
        }
        return dst
    }
}
