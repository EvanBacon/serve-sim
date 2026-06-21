import Foundation
import CoreVideo
import CoreMedia

// C-ABI wrapper around the existing FrameCapture + VideoEncoder + H264Encoder,
// reused verbatim from SimStreamHelper. Replicates main.swift's frameHandler:
// MJPEG always encodes while clients exist; H.264 runs only while AVCC is active.
// Encoded bytes (JPEG, or natively-framed AVCC envelopes) are handed to the
// Objective-C++ N-API layer through a @convention(c) callback, which marshals
// them onto the JS thread via a threadsafe function.

/// (ctx, codec, dataPtr, len, width, height, flags) -> Void.
/// codec: 0 = MJPEG, 1 = AVCC. flags (AVCC): bit0 = description, bit1 = keyframe.
/// The data pointer is only valid for the duration of the call — the N-API layer
/// copies before returning.
public typealias SimFrameCallback = @convention(c) (
    UnsafeMutableRawPointer?, Int32, UnsafePointer<UInt8>?, Int, Int32, Int32, Int32
) -> Void

final class SimCapture {
    static let codecMJPEG: Int32 = 0
    static let codecAVCC: Int32 = 1
    static let flagDescription: Int32 = 1 << 0
    static let flagKeyframe: Int32 = 1 << 1

    private let deviceUDID: String
    private let cb: SimFrameCallback
    private let ctx: UnsafeMutableRawPointer?

    private let frameCapture = FrameCapture()
    private let videoEncoder = VideoEncoder(quality: 0.7)
    private let h264Encoder = H264Encoder(fps: 60)
    private let encodeQueue = DispatchQueue(label: "napi.encode", qos: .userInteractive)
    private let h264Queue = DispatchQueue(label: "napi.encode.h264", qos: .userInteractive)

    // Mirrors main.swift's globals; mutated from the capture queue, read from the
    // encode queues. Benign races (same pattern as the standalone helper).
    private var screenWidth = 0
    private var screenHeight = 0
    private var encoderReady = false
    private var encoding = false       // MJPEG backpressure
    private var h264Encoding = false   // H.264 backpressure
    private var forceKeyframe = false
    private var avccActive = false
    private var started = false
    private var stopped = false

    init(deviceUDID: String, cb: @escaping SimFrameCallback, ctx: UnsafeMutableRawPointer?) {
        self.deviceUDID = deviceUDID
        self.cb = cb
        self.ctx = ctx

        h264Encoder.onEncoded = { [weak self] encoded in
            guard let self else { return }
            if let description = encoded.description {
                self.emit(codec: Self.codecAVCC,
                          data: AVCCEnvelope.description(avcc: description),
                          flags: Self.flagDescription)
            }
            switch encoded.kind {
            case .keyframe:
                self.emit(codec: Self.codecAVCC, data: AVCCEnvelope.keyframe(avcc: encoded.avcc),
                          flags: Self.flagKeyframe)
            case .delta:
                self.emit(codec: Self.codecAVCC, data: AVCCEnvelope.delta(avcc: encoded.avcc), flags: 0)
            }
        }
    }

    /// Hand encoded bytes to the N-API layer. Gated by `stopped` so no callback
    /// fires once teardown has begun.
    private func emit(codec: Int32, data: Data, flags: Int32) {
        if stopped { return }
        let w = Int32(screenWidth), h = Int32(screenHeight)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            cb(ctx, codec, raw.bindMemory(to: UInt8.self).baseAddress, data.count, w, h, flags)
        }
    }

    func start() throws {
        guard !started else { return }
        started = true
        try frameCapture.start(deviceUDID: deviceUDID) { [weak self] pixelBuffer, _ in
            self?.handleFrame(pixelBuffer)
        }
    }

    private func handleFrame(_ pixelBuffer: CVPixelBuffer) {
        let w = CVPixelBufferGetWidth(pixelBuffer)
        let h = CVPixelBufferGetHeight(pixelBuffer)

        if !encoderReady || w != screenWidth || h != screenHeight {
            screenWidth = w
            screenHeight = h
            videoEncoder.stop()
            videoEncoder.setup(width: Int32(w), height: Int32(h), fps: 60) { [weak self] jpeg in
                self?.emit(codec: Self.codecMJPEG, data: jpeg, flags: 0)
            }
            encoderReady = true
        }

        if encoderReady, !encoding {
            encoding = true
            encodeQueue.async { [weak self] in
                guard let self else { return }
                self.videoEncoder.encode(pixelBuffer: pixelBuffer)
                self.encoding = false
            }
        }

        // H.264 runs only while a viewer wants AVCC, so an all-MJPEG session pays
        // no VideoToolbox cost.
        if avccActive {
            h264Queue.async { [weak self] in
                guard let self else { return }
                if self.h264Encoding { return }
                self.h264Encoding = true
                let force = self.forceKeyframe
                self.forceKeyframe = false
                self.h264Encoder.encode(pixelBuffer, forceKeyframe: force) {
                    self.h264Queue.async { self.h264Encoding = false }
                }
            }
        }
    }

    /// Toggle H.264 encoding. Turning it on forces the next frame to an IDR so a
    /// freshly-connected decoder has a keyframe to start from.
    func setAvccActive(_ active: Bool) {
        h264Queue.async { [weak self] in
            guard let self else { return }
            if active && !self.avccActive { self.forceKeyframe = true }
            self.avccActive = active
        }
    }

    func requestKeyframe() {
        h264Queue.async { [weak self] in self?.forceKeyframe = true }
    }

    func screenSize() -> (Int, Int) { (screenWidth, screenHeight) }

    /// Halt frame production and drain the encode queues so no callback can fire
    /// after this returns — the N-API layer relies on that before releasing the
    /// threadsafe function.
    func stop() {
        if stopped { return }
        stopped = true
        frameCapture.stop()
        encodeQueue.sync {}
        h264Queue.sync {}
        videoEncoder.stop()
        h264Encoder.stop()
    }
}

// MARK: - C ABI

private func capture(_ handle: UnsafeMutableRawPointer) -> SimCapture {
    Unmanaged<SimCapture>.fromOpaque(handle).takeUnretainedValue()
}

@_cdecl("sim_capture_create")
public func sim_capture_create(
    _ udid: UnsafePointer<CChar>,
    _ cb: @escaping SimFrameCallback,
    _ ctx: UnsafeMutableRawPointer?
) -> UnsafeMutableRawPointer {
    let cap = SimCapture(deviceUDID: String(cString: udid), cb: cb, ctx: ctx)
    return Unmanaged.passRetained(cap).toOpaque()
}

@_cdecl("sim_capture_start")
public func sim_capture_start(
    _ handle: UnsafeMutableRawPointer,
    _ errOut: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
) -> Bool {
    do {
        try capture(handle).start()
        return true
    } catch {
        errOut.pointee = strdup(error.localizedDescription)
        return false
    }
}

@_cdecl("sim_capture_set_avcc_active")
public func sim_capture_set_avcc_active(_ handle: UnsafeMutableRawPointer, _ active: Bool) {
    capture(handle).setAvccActive(active)
}

@_cdecl("sim_capture_request_keyframe")
public func sim_capture_request_keyframe(_ handle: UnsafeMutableRawPointer) {
    capture(handle).requestKeyframe()
}

@_cdecl("sim_capture_screen_size")
public func sim_capture_screen_size(
    _ handle: UnsafeMutableRawPointer,
    _ outW: UnsafeMutablePointer<Int32>,
    _ outH: UnsafeMutablePointer<Int32>
) {
    let (w, h) = capture(handle).screenSize()
    outW.pointee = Int32(w)
    outH.pointee = Int32(h)
}

/// Stop capture + encoders. Safe to call before destroy; idempotent.
@_cdecl("sim_capture_stop")
public func sim_capture_stop(_ handle: UnsafeMutableRawPointer) {
    capture(handle).stop()
}

/// Stop (if needed) and release the retained SimCapture.
@_cdecl("sim_capture_destroy")
public func sim_capture_destroy(_ handle: UnsafeMutableRawPointer) {
    let cap = Unmanaged<SimCapture>.fromOpaque(handle)
    cap.takeUnretainedValue().stop()
    cap.release()
}
