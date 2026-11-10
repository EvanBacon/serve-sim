// Test fixture generator: writes a tiny synthetic H.264 MP4 so the
// `serve-sim record frame|diff` tests never check media into the repo.
// Compiled at test time with `xcrun swiftc` (see record-inspect.integration.test.ts).
//
//   make-test-video <out.mp4> <width> <height> <fps> <spec.json>
//
// spec.json: one entry per frame, `{ "bg": [r,g,b], "rect"?: [x,y,w,h,r,g,b] }`
// (0-255 colors, rect in pixels from the top-left).
import AVFoundation
import CoreVideo
import Foundation

struct FrameSpec: Decodable {
    let bg: [Int]
    let rect: [Int]?
}

let args = CommandLine.arguments
guard args.count == 6, let width = Int(args[2]), let height = Int(args[3]), let fps = Int32(args[4]) else {
    FileHandle.standardError.write("usage: make-test-video <out.mp4> <width> <height> <fps> <spec.json>\n".data(using: .utf8)!)
    exit(2)
}
let out = URL(fileURLWithPath: args[1])
let specs = try JSONDecoder().decode([FrameSpec].self, from: Data(contentsOf: URL(fileURLWithPath: args[5])))
try? FileManager.default.removeItem(at: out)

let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 4_000_000],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
])
writer.add(input)
guard writer.startWriting() else {
    FileHandle.standardError.write("startWriting failed: \(String(describing: writer.error))\n".data(using: .utf8)!)
    exit(1)
}
writer.startSession(atSourceTime: .zero)

func fill(_ buffer: CVPixelBuffer, _ spec: FrameSpec) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    func paint(_ x0: Int, _ y0: Int, _ w: Int, _ h: Int, _ r: Int, _ g: Int, _ b: Int) {
        for y in max(0, y0)..<min(height, y0 + h) {
            for x in max(0, x0)..<min(width, x0 + w) {
                let p = base + y * stride + x * 4
                p[0] = UInt8(b); p[1] = UInt8(g); p[2] = UInt8(r); p[3] = 255
            }
        }
    }
    paint(0, 0, width, height, spec.bg[0], spec.bg[1], spec.bg[2])
    if let r = spec.rect { paint(r[0], r[1], r[2], r[3], r[4], r[5], r[6]) }
}

for (i, spec) in specs.enumerated() {
    while !input.isReadyForMoreMediaData { usleep(1000) }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
    fill(buffer!, spec)
    adaptor.append(buffer!, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps))
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.endSession(atSourceTime: CMTime(value: CMTimeValue(specs.count), timescale: fps))
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed {
    FileHandle.standardError.write("finishWriting failed: \(String(describing: writer.error))\n".data(using: .utf8)!)
    exit(1)
}
