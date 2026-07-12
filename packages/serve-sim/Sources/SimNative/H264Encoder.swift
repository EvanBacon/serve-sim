import Foundation
import CoreVideo
import CoreMedia
import VideoToolbox

/// Real-time H.264 encoder backed by `VTCompressionSession`, producing AVCC
/// (length-prefixed NAL) output for the `/stream.avcc` endpoint.
///
/// Submission is fire-and-forget: the caller hands a `CVPixelBuffer` in and
/// the encoded chunk comes back via `onEncoded` on VideoToolbox's own queue.
/// The incoming buffer wraps SimulatorKit's live framebuffer IOSurface, which
/// SimulatorKit recycles in place — VT encodes asynchronously, so we deep-copy
/// into a private pooled buffer before submitting to avoid a torn frame race.
actor H264Encoder {
    let queue = DispatchSerialQueue(label: "h264-encoder", qos: .userInteractive)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    struct Encoded {
        /// avcC parameter-set blob — emitted once on the first IDR per session.
        let description: Data?
        let kind: Kind
        /// Length-prefixed AVCC NAL bytes (not Annex-B start codes).
        let avcc: Data
        enum Kind { case keyframe, delta }
    }

    private var session: VTCompressionSession?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private let fps: Int32
    private var bitrate: Int
    private var emittedDescription = false
    private var frameCount: Int64 = 0

    init(fps: Int = 60, bitrate: Int = 6_000_000) {
        self.fps = Int32(fps)
        self.bitrate = bitrate
    }

    deinit {
        if let session { VTCompressionSessionInvalidate(session) }
    }

    /// Submit a frame. Returns immediately; `onEncoded` fires on VT's queue.
    func encode(_ source: CVPixelBuffer, forceKeyframe: Bool = false) async throws -> Encoded {
        let w = Int32(CVPixelBufferGetWidth(source))
        let h = Int32(CVPixelBufferGetHeight(source))
        if session == nil || w != width || h != height {
            width = w
            height = h
            rebuildSession()
        }
        guard let session else {
            throw Errors.couldNotCreateSession
        }

        frameCount += 1
        let pts = CMTime(value: frameCount, timescale: fps)
        let frameProps: NSDictionary? = forceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as NSDictionary
            : nil

        let buffer: CMSampleBuffer? = await withCheckedContinuation { continuation in
            let status = VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: source,
                presentationTimeStamp: pts,
                duration: .invalid,
                frameProperties: frameProps,
                infoFlagsOut: nil
            ) { @Sendable status, _, sampleBuffer in
                guard status == noErr, let sb = sampleBuffer else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: sb)
            }
            if status != noErr {
                continuation.resume(returning: nil)
            }
        }
        guard let buffer else { throw Errors.encodingFailed }
        return try extract(from: buffer)
    }

    func stop() {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
    }

    // MARK: - private

    private func rebuildSession() {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }

        // Low-latency rate control puts VideoToolbox in its real-time/low-delay
        // pipeline and, crucially, emits a bitstream the *decoder* treats as
        // low-latency (small max_dec_frame_buffering). Without it the decoder
        // fills a large DPB before emitting, adding ~300ms of latency on the
        // client even though the stream carries no B-frames. Falls back to the
        // default spec on the rare hardware that rejects it.
        let lowLatencySpec: NSDictionary = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!,
        ]
        var sess: VTCompressionSession?
        func create(spec: CFDictionary?) -> OSStatus {
            VTCompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                width: width, height: height,
                codecType: kCMVideoCodecType_H264,
                encoderSpecification: spec,
                imageBufferAttributes: nil,
                compressedDataAllocator: kCFAllocatorDefault,
                outputCallback: nil,
                refcon: nil,
                compressionSessionOut: &sess
            )
        }
        var status = create(spec: lowLatencySpec)
        if status != noErr || sess == nil {
            sess = nil
            status = create(spec: nil)
        }
        guard status == noErr, let sess else { return }

        let props: [(CFString, Any)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
            // 5s keyframe interval: IDRs are far larger than P-frames, so
            // spacing them out keeps scroll/animation smooth. Late joiners
            // don't wait for the natural IDR — we force one on connect.
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: fps * 5)),
        ]
        for (key, value) in props {
            VTSessionSetProperty(sess, key: key, value: value as CFTypeRef)
        }
        VTCompressionSessionPrepareToEncodeFrames(sess)
        session = sess
        emittedDescription = false
    }

    private func extract(from sample: CMSampleBuffer) throws -> Encoded {
        let isKeyframe = !notSync(sample)
        guard let dataBuf = CMSampleBufferGetDataBuffer(sample) else {
            throw Errors.invalidSampleBuffer
        }

        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            dataBuf, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &dataPointer
        ) == noErr, let dataPointer else {
            throw Errors.invalidSampleBuffer
        }
        let avcc = Data(bytes: dataPointer, count: totalLength)

        var description: Data?
        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sample) {
            let nextDescription = avcCBlob(from: format)
            if !emittedDescription && nextDescription != nil {
                emittedDescription = true
                description = nextDescription
            }
        }
        return Encoded(description: description, kind: isKeyframe ? .keyframe : .delta, avcc: avcc)
    }

    private func notSync(_ sample: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0,
              let dict = CFArrayGetValueAtIndex(attachments, 0) else { return false }
        let cfDict = unsafeBitCast(dict, to: CFDictionary.self)
        return CFDictionaryContainsKey(cfDict, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque())
    }

    /// avcC parameter-set blob (ISO/IEC 14496-15 §5.2.4.1) carrying SPS + PPS.
    private func avcCBlob(from format: CMFormatDescription) -> Data? {
        var spsCount = 0
        var spsPtr: UnsafePointer<UInt8>?
        var spsSize = 0
        var nalSize: Int32 = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0,
            parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize,
            parameterSetCountOut: &spsCount, nalUnitHeaderLengthOut: &nalSize
        ) == noErr, let spsPtr, spsSize >= 4 else { return nil }

        var ppsPtr: UnsafePointer<UInt8>?
        var ppsSize = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 1,
            parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
        ) == noErr, let ppsPtr else { return nil }

        let sps = UnsafeBufferPointer(start: spsPtr, count: spsSize)
        let pps = UnsafeBufferPointer(start: ppsPtr, count: ppsSize)
        var blob = Data()
        blob.append(0x01)
        blob.append(sps[1]); blob.append(sps[2]); blob.append(sps[3])
        blob.append(0xFF)
        blob.append(0xE1)
        blob.append(UInt8((spsSize >> 8) & 0xFF)); blob.append(UInt8(spsSize & 0xFF))
        blob.append(contentsOf: sps)
        blob.append(0x01)
        blob.append(UInt8((ppsSize >> 8) & 0xFF)); blob.append(UInt8(ppsSize & 0xFF))
        blob.append(contentsOf: pps)
        return blob
    }

    enum Errors: Error {
        case couldNotCreateSession
        case encodingFailed
        case invalidSampleBuffer
    }
}
