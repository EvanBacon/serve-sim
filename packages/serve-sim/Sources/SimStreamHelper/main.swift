import Foundation
import CoreVideo
import CoreMedia
import AppKit

// Force unbuffered output
setbuf(stdout, nil)
setbuf(stderr, nil)

// Initialize AppKit (needed for HID touch subprocess)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let args = CommandLine.arguments

// Diagnostic: capture ground-truth scroll bytes from a real SimHIDCaptureManager
// session. Usage: serve-sim-bin --capture-scroll <udid> [seconds]
if args.count >= 3, args[1] == "--capture-scroll" {
    let secs = args.count >= 4 ? (Double(args[3]) ?? 20) : 20
    CaptureScroll.run(udid: args[2], seconds: secs)
    // CaptureScroll.run calls exit(); this is unreachable.
}

guard args.count >= 2 else {
    fputs("Usage: serve-sim-bin <device-udid> [--port 3100]\n", stderr)
    exit(1)
}

let deviceUDID = args[1]
var port: UInt16 = 3100

// Parse optional --port flag
if let portIdx = args.firstIndex(of: "--port"), portIdx + 1 < args.count,
   let p = UInt16(args[portIdx + 1]) {
    port = p
}

print("[main] Starting serve-sim-bin")
print("[main] Device UDID: \(deviceUDID)")
print("[main] Port: \(port)")

let httpServer = HTTPServer(deviceUDID: deviceUDID, port: port)
let frameCapture = FrameCapture()
let videoEncoder = VideoEncoder(quality: 0.7)
let h264Encoder = H264Encoder(fps: 60)
let hidInjector = HIDInjector()
let encodeQueue = DispatchQueue(label: "encode", qos: .userInteractive)
let h264Queue = DispatchQueue(label: "encode.h264", qos: .userInteractive)

var screenWidth = 0
var screenHeight = 0
var encoderReady = false
var encoding = false // backpressure flag (MJPEG)
var h264Encoding = false // backpressure flag (H.264)
// Set when an AVCC client connects; the next H.264 frame is forced to an IDR
// so the freshly-configured decoder has a keyframe to start from.
var forceKeyframe = false

// ─── H.264 capability probe ───
// VideoToolbox H.264 encode silently no-ops on some virtualized macOS hosts:
// `VTCompressionSessionCreate` succeeds but no encoded frame is ever produced.
// At startup we feed a few captured frames through the encoder — independent of
// any AVCC viewer — and watch for output, so the preview can default to MJPEG
// immediately instead of stalling on a frozen seed. All probe state is touched
// only on `h264Queue`.
var h264Decided = false       // true once support is known either way
var h264OK = false            // decided AND VideoToolbox actually encodes
var h264ProbeStart: Date?     // first probe frame's timestamp
let h264ProbeTimeout: TimeInterval = 3.0

// H.264 output → AVCC envelope → broadcast to /stream.avcc clients.
h264Encoder.onEncoded = { encoded in
    // First successful output proves VideoToolbox H.264 works on this host.
    h264Queue.async {
        if !h264Decided {
            h264Decided = true
            h264OK = true
            print("[h264] probe: VideoToolbox H.264 encode OK")
            httpServer.clientManager.setH264Supported(true)
        }
    }
    if let description = encoded.description {
        httpServer.clientManager.broadcastAvcc(AVCCEnvelope.description(avcc: description), isDescription: true)
    }
    switch encoded.kind {
    case .keyframe: httpServer.clientManager.broadcastAvcc(AVCCEnvelope.keyframe(avcc: encoded.avcc))
    case .delta: httpServer.clientManager.broadcastAvcc(AVCCEnvelope.delta(avcc: encoded.avcc))
    }
}
httpServer.clientManager.onAvccClientConnect = {
    h264Queue.async {
        forceKeyframe = true
    }
}

// Setup HID injector
do {
    try hidInjector.setup(deviceUDID: deviceUDID)
} catch {
    print("[main] Warning: HID setup failed: \(error.localizedDescription)")
}

// Wire client manager → HID injector
httpServer.clientManager.onTouch = { touch in
    hidInjector.sendTouch(type: touch.type, x: touch.x, y: touch.y,
                          screenWidth: screenWidth, screenHeight: screenHeight,
                          edge: touch.edge ?? 0)
}
httpServer.clientManager.onButton = { button in
    hidInjector.sendButton(button: button, deviceUDID: deviceUDID)
}
httpServer.clientManager.onButtonHID = { page, usage, phase in
    hidInjector.sendButtonHID(page: page, usage: usage, phase: phase)
}
httpServer.clientManager.onMultiTouch = { multiTouch in
    hidInjector.sendMultiTouch(type: multiTouch.type,
                               x1: multiTouch.x1, y1: multiTouch.y1,
                               x2: multiTouch.x2, y2: multiTouch.y2,
                               screenWidth: screenWidth, screenHeight: screenHeight)
}
httpServer.clientManager.onKey = { key in
    hidInjector.sendKey(type: key.type, usage: key.usage)
}
httpServer.clientManager.onOrientation = { orientation in
    hidInjector.sendOrientation(orientation: orientation)
}
httpServer.clientManager.onCADebug = { payload in
    _ = hidInjector.setCADebugOption(name: payload.option, enabled: payload.enabled)
}
httpServer.clientManager.onMemoryWarning = {
    hidInjector.simulateMemoryWarning()
}
httpServer.clientManager.onDigitalCrown = { payload in
    hidInjector.sendDigitalCrown(delta: payload.delta)
}
httpServer.clientManager.onScroll = { payload in
    // Payload deltas are a fraction of the display; scale to device pixels.
    hidInjector.sendScroll(dx: payload.dx * Double(screenWidth),
                           dy: payload.dy * Double(screenHeight),
                           anchorX: payload.x, anchorY: payload.y,
                           screenWidth: screenWidth, screenHeight: screenHeight)
}

// Start HTTP + WebSocket server
do {
    try httpServer.start()
} catch {
    print("[main] Failed to start server: \(error.localizedDescription)")
    exit(1)
}

// Start frame capture — encoder is initialized lazily on first frame.
// The framebuffer surface may not be available immediately after boot,
// so retry a few times with backoff before giving up.
let frameHandler: (CVPixelBuffer, CMTime) -> Void = { pixelBuffer, timestamp in
    let w = CVPixelBufferGetWidth(pixelBuffer)
    let h = CVPixelBufferGetHeight(pixelBuffer)

    // Initialize encoder on first frame with actual dimensions
    if !encoderReady || w != screenWidth || h != screenHeight {
        screenWidth = w
        screenHeight = h
        print("[main] Frame dimensions: \(w)x\(h), (re)initializing encoder")

        videoEncoder.stop()
        videoEncoder.setup(
            width: Int32(w),
            height: Int32(h),
            fps: 60,
            onEncodedFrame: { jpegData in
                httpServer.clientManager.broadcastFrame(jpegData: jpegData)
            }
        )
        encoderReady = true

        // Update client manager config
        httpServer.clientManager.setScreenSize(width: w, height: h)
    }

    if encoderReady, !encoding {
        // Backpressure: skip frame if encoder is still working on the previous one
        encoding = true
        encodeQueue.async {
            videoEncoder.encode(pixelBuffer: pixelBuffer)
            encoding = false
        }
    }

    // H.264 path runs while an AVCC viewer is connected (so an all-MJPEG
    // session pays no VideoToolbox cost) OR while the startup probe is still
    // deciding whether this host can encode H.264 at all. All probe/backpressure
    // state (`h264Decided`, `h264OK`, `h264ProbeStart`, `h264Encoding`,
    // `forceKeyframe`) is confined to `h264Queue`, so the gating decision is made
    // inside the queue rather than read racily from the capture thread.
    h264Queue.async {
        let hasAvccClients = httpServer.clientManager.hasAvccClients()
        guard hasAvccClients || !h264Decided else { return }

        if !h264Decided {
            // Drive the one-shot probe: force the first frame to a keyframe so
            // VideoToolbox produces an IDR fast, and give up (→ MJPEG) if nothing
            // comes back within the timeout. This decision runs before the
            // backpressure check below so a wedged encode can't suppress it.
            if h264ProbeStart == nil {
                h264ProbeStart = Date()
                forceKeyframe = true
            } else if Date().timeIntervalSince(h264ProbeStart!) > h264ProbeTimeout {
                h264Decided = true
                h264OK = false
                print("[h264] probe: no VideoToolbox output in \(Int(h264ProbeTimeout))s — viewers will use MJPEG")
                httpServer.clientManager.setH264Supported(false)
                return
            }
        } else if !h264OK || !hasAvccClients {
            // Decided unsupported, or no viewers: nothing to encode.
            return
        }

        // Backpressure: skip this frame if the previous encode is still in flight.
        if h264Encoding { return }
        h264Encoding = true
        let force = forceKeyframe
        forceKeyframe = false
        h264Encoder.encode(pixelBuffer, forceKeyframe: force) {
            h264Queue.async {
                h264Encoding = false
            }
        }
    }
}

do {
    try frameCapture.start(deviceUDID: deviceUDID, onFrame: frameHandler)
    print("[main] Capture started, waiting for frames...")
    print("\nOpen your browser at: http://localhost:\(port)")
    print("Press Ctrl+C to stop.\n")
} catch {
    print("[main] Failed to start capture: \(error.localizedDescription)")
    exit(1)
}

// Shutdown handlers
signal(SIGINT) { _ in
    print("\n[main] Shutting down...")
    frameCapture.stop()
    videoEncoder.stop()
    h264Encoder.stop()
    httpServer.stop()
    exit(0)
}

signal(SIGTERM) { _ in
    frameCapture.stop()
    videoEncoder.stop()
    h264Encoder.stop()
    httpServer.stop()
    exit(0)
}

RunLoop.main.run()
