// Centre-pixel decoder for bench-stream.ts. Reads framed records on stdin:
//   [u32 BE length][u8 kind][payload]   kind 1 = avcC, 2 = AVCC sample, 3 = JPEG
// and writes one line per decoded frame (kinds 2 and 3, in input order):
//   "<r> <g> <b>\n"   (or "- - -\n" when a frame could not be decoded)
// Build: swiftc -O -o /tmp/serve-sim-frame-decoder frame-decoder.swift
import Foundation
import VideoToolbox
import CoreMedia
import ImageIO

setvbuf(stdout, nil, _IOLBF, 0)
var format: CMVideoFormatDescription?
var session: VTDecompressionSession?
var lastRGB = "- - -"

func readExactly(_ n: Int) -> Data? {
    var out = Data(capacity: n)
    while out.count < n {
        let chunk = FileHandle.standardInput.readData(ofLength: n - out.count)
        if chunk.isEmpty { return nil }
        out.append(chunk)
    }
    return out
}

func centre(_ pb: CVPixelBuffer) -> String {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return "- - -" }
    let p = base.advanced(by: (h / 2) * CVPixelBufferGetBytesPerRow(pb) + (w / 2) * 4).assumingMemoryBound(to: UInt8.self)
    return "\(p[2]) \(p[1]) \(p[0])"
}

func configure(_ avcc: Data) {
    let bytes = [UInt8](avcc)
    var off = 5
    var sets: [[UInt8]] = []
    let nSps = Int(bytes[off] & 0x1f); off += 1
    for _ in 0..<nSps { let l = Int(bytes[off]) << 8 | Int(bytes[off + 1]); off += 2; sets.append(Array(bytes[off..<off + l])); off += l }
    let nPps = Int(bytes[off]); off += 1
    for _ in 0..<nPps { let l = Int(bytes[off]) << 8 | Int(bytes[off + 1]); off += 2; sets.append(Array(bytes[off..<off + l])); off += l }
    var fmt: CMVideoFormatDescription?
    let ptrs = sets.map { s -> UnsafePointer<UInt8> in
        let p = UnsafeMutablePointer<UInt8>.allocate(capacity: s.count); p.initialize(from: s, count: s.count); return UnsafePointer(p)
    }
    let sizes = sets.map { $0.count }
    CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: nil, parameterSetCount: sets.count,
        parameterSetPointers: ptrs, parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &fmt)
    guard let fmt else { return }
    if let session { VTDecompressionSessionInvalidate(session) }
    format = fmt
    let attrs = [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary
    var s: VTDecompressionSession?
    VTDecompressionSessionCreate(allocator: nil, formatDescription: fmt, decoderSpecification: nil,
                                 imageBufferAttributes: attrs, outputCallback: nil, decompressionSessionOut: &s)
    session = s
}

func decodeAvcc(_ data: Data) -> String {
    guard let session, let format else { return "- - -" }
    var block: CMBlockBuffer?
    let len = data.count
    let mem = UnsafeMutableRawPointer.allocate(byteCount: len, alignment: 1)
    data.copyBytes(to: mem.assumingMemoryBound(to: UInt8.self), count: len)
    CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: mem, blockLength: len, blockAllocator: kCFAllocatorMalloc,
                                       customBlockSource: nil, offsetToData: 0, dataLength: len, flags: 0, blockBufferOut: &block)
    var sample: CMSampleBuffer?
    var size = len
    CMSampleBufferCreateReady(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: 1,
                              sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1,
                              sampleSizeArray: &size, sampleBufferOut: &sample)
    guard let sample else { return "- - -" }
    var result = "- - -"
    VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [], infoFlagsOut: nil) { status, _, image, _, _ in
        if status == noErr, let image { result = centre(image) }
    }
    return result
}

func decodeJpeg(_ data: Data) -> String {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
          let crop = img.cropping(to: CGRect(x: img.width / 2, y: img.height / 2, width: 1, height: 1)) else { return "- - -" }
    var px = [UInt8](repeating: 0, count: 4)
    let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(crop, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    return "\(px[0]) \(px[1]) \(px[2])"
}

while let head = readExactly(5) {
    let len = Int(head[0]) << 24 | Int(head[1]) << 16 | Int(head[2]) << 8 | Int(head[3])
    let kind = head[4]
    guard let payload = readExactly(len) else { break }
    switch kind {
    case 1: configure(payload)
    case 2: print(decodeAvcc(payload))
    case 3: print(decodeJpeg(payload))
    default: break
    }
}
