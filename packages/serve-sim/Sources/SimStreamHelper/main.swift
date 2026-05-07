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
let hidInjector = HIDInjector()
let encodeQueue = DispatchQueue(label: "encode", qos: .userInteractive)

var screenWidth = 0
var screenHeight = 0
var encoderReady = false
var encoding = false // backpressure flag

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

    if encoderReady {
        // Backpressure: skip frame if encoder is still working on the previous one
        guard !encoding else { return }
        encoding = true
        encodeQueue.async {
            videoEncoder.encode(pixelBuffer: pixelBuffer)
            encoding = false
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
    httpServer.stop()
    exit(0)
}

signal(SIGTERM) { _ in
    frameCapture.stop()
    videoEncoder.stop()
    httpServer.stop()
    exit(0)
}

RunLoop.main.run()
