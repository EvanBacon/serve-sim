import Foundation

/// Wire format a viewer can request for the screen stream.
///
/// - `mjpeg`: stateless JPEG-per-frame inside a `multipart/x-mixed-replace`
///   envelope. Works in any `<img>`; high bandwidth.
/// - `avcc`: length-prefixed H.264 NAL chunks (AVCC framing) decoded by the
///   browser's WebCodecs `VideoDecoder`. ~5-10x less bandwidth; needs a
///   canvas + `VideoDecoder`, so the client feature-detects and falls back
///   to `mjpeg`.
enum StreamFormat: String {
    case mjpeg
    case avcc
}

/// Bytes that wrap each chunk on the `/stream.avcc` wire. Every chunk is a
/// 4-byte big-endian length (covering the tag byte + payload) followed by a
/// one-byte tag and the payload:
///
/// - `0x01` description — avcC parameter-set blob (SPS/PPS); configures the
///   decoder. Emitted once per encoder session and replayed to late joiners.
/// - `0x02` keyframe — IDR (decoder can start here).
/// - `0x03` delta — non-IDR P-frame (depends on prior frames).
/// - `0x04` seed — a JPEG painted immediately on connect so the viewer sees
///   the current screen before the first IDR decodes.
///
/// A parser reads the 4-byte length, then `length` bytes that begin with the
/// tag. Mirrors baguette's `AVCCEnvelope` so the same browser decoder works.
enum AVCCEnvelope {
    static let descriptionTag: UInt8 = 0x01
    static let keyframeTag: UInt8 = 0x02
    static let deltaTag: UInt8 = 0x03
    static let seedTag: UInt8 = 0x04

    static func description(avcc: Data) -> Data { wrap(tag: descriptionTag, payload: avcc) }
    static func keyframe(avcc: Data) -> Data { wrap(tag: keyframeTag, payload: avcc) }
    static func delta(avcc: Data) -> Data { wrap(tag: deltaTag, payload: avcc) }
    static func seed(jpeg: Data) -> Data { wrap(tag: seedTag, payload: jpeg) }

    private static func wrap(tag: UInt8, payload: Data) -> Data {
        let length = UInt32(payload.count + 1)
        var out = Data(capacity: 5 + payload.count)
        out.append(UInt8((length >> 24) & 0xFF))
        out.append(UInt8((length >> 16) & 0xFF))
        out.append(UInt8((length >> 8) & 0xFF))
        out.append(UInt8(length & 0xFF))
        out.append(tag)
        out.append(payload)
        return out
    }
}
