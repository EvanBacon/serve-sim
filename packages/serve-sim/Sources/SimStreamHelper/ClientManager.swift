import Foundation
import Swifter

/// Manages WebSocket clients for input and MJPEG stream clients for video.
final class ClientManager {
    private var wsSessions: [ObjectIdentifier: WebSocketSession] = [:]
    private let queue = DispatchQueue(label: "client-manager")
    private let configLock = NSLock()

    private var screenWidth = 0
    private var screenHeight = 0
    private var screenOrientation = "portrait"

    /// Latest JPEG frame data, replaced on each new frame
    private var latestFrame: Data?
    private var mjpegClients: [ObjectIdentifier: MJPEGClient] = [:]
    private var nextClientId = 0

    var onTouch: ((TouchEventPayload) -> Void)?
    var onButton: ((String) -> Void)?
    var onMultiTouch: ((MultiTouchEventPayload) -> Void)?
    var onKey: ((KeyEventPayload) -> Void)?
    var onOrientation: ((UInt32) -> Bool)?
    var onCADebug: ((CADebugEventPayload) -> Void)?
    var onMemoryWarning: (() -> Void)?

    // MARK: - Configuration

    func setScreenSize(width: Int, height: Int) {
        configLock.lock()
        screenWidth = width
        screenHeight = height
        configLock.unlock()
    }

    private func setScreenOrientation(_ orientation: String) {
        configLock.lock()
        screenOrientation = orientation
        configLock.unlock()
    }

    func screenConfig() -> [String: Any] {
        configLock.lock()
        defer { configLock.unlock() }
        return [
            "width": screenWidth,
            "height": screenHeight,
            "orientation": screenOrientation,
        ]
    }

    // MARK: - MJPEG Client Management

    func addMJPEGClient() -> MJPEGClient {
        let client = MJPEGClient(id: nextClientId)
        nextClientId += 1
        let key = ObjectIdentifier(client)
        queue.async {
            self.mjpegClients[key] = client
            print("[clients] MJPEG client connected (\(self.mjpegClients.count) total)")
        }
        return client
    }

    /// Send the latest cached frame to a client (call after writer is attached).
    func sendLatestFrame(to client: MJPEGClient) {
        queue.async {
            if let frame = self.latestFrame {
                client.send(frame: frame)
            }
        }
    }

    func removeMJPEGClient(_ client: MJPEGClient) {
        let key = ObjectIdentifier(client)
        queue.async {
            self.mjpegClients.removeValue(forKey: key)
            print("[clients] MJPEG client disconnected (\(self.mjpegClients.count) total)")
        }
    }

    // MARK: - WebSocket Client Management (input only)

    func addWSClient(_ session: WebSocketSession) {
        let id = ObjectIdentifier(session)
        queue.async {
            self.wsSessions[id] = session
            print("[clients] WS input client connected (\(self.wsSessions.count) total)")
        }
    }

    func removeWSClient(_ session: WebSocketSession) {
        let id = ObjectIdentifier(session)
        queue.async {
            self.wsSessions.removeValue(forKey: id)
            print("[clients] WS input client disconnected (\(self.wsSessions.count) total)")
        }
    }

    // MARK: - Message Handling

    func handleMessage(from session: WebSocketSession, data: Data) {
        guard data.count >= 1 else { return }
        let type = data[0]

        if type == 0x03 { // WS_MSG_TOUCH
            guard let json = try? JSONDecoder().decode(TouchEventPayload.self, from: data[1...]) else { return }
            onTouch?(json)
        } else if type == 0x04 { // WS_MSG_BUTTON
            guard let json = try? JSONDecoder().decode(ButtonEventPayload.self, from: data[1...]) else { return }
            onButton?(json.button)
        } else if type == 0x05 { // WS_MSG_MULTI_TOUCH
            guard let json = try? JSONDecoder().decode(MultiTouchEventPayload.self, from: data[1...]) else { return }
            onMultiTouch?(json)
        } else if type == 0x06 { // WS_MSG_KEY
            guard let json = try? JSONDecoder().decode(KeyEventPayload.self, from: data[1...]) else { return }
            onKey?(json)
        } else if type == 0x07 { // WS_MSG_ORIENTATION
            guard let json = try? JSONDecoder().decode(OrientationEventPayload.self, from: data[1...]) else { return }
            let value: UInt32
            switch json.orientation {
            case "portrait":             value = HIDInjector.orientationPortrait
            case "portrait_upside_down": value = HIDInjector.orientationPortraitUpsideDown
            case "landscape_left":       value = HIDInjector.orientationLandscapeLeft
            case "landscape_right":      value = HIDInjector.orientationLandscapeRight
            default:
                print("[clients] Unknown orientation: \(json.orientation)")
                return
            }
            if onOrientation?(value) == true {
                setScreenOrientation(json.orientation)
            } else {
                print("[clients] Orientation request failed: \(json.orientation)")
            }
        } else if type == 0x08 { // WS_MSG_CA_DEBUG
            guard let json = try? JSONDecoder().decode(CADebugEventPayload.self, from: data[1...]) else { return }
            onCADebug?(json)
        } else if type == 0x09 { // WS_MSG_MEMORY_WARNING
            onMemoryWarning?()
        }
    }

    // MARK: - Frame Broadcasting

    func broadcastFrame(jpegData: Data) {
        queue.async {
            self.latestFrame = jpegData
            guard !self.mjpegClients.isEmpty else { return }
            for (_, client) in self.mjpegClients {
                client.send(frame: jpegData)
            }
        }
    }

    func stop() {
        queue.async {
            for (_, client) in self.mjpegClients {
                client.close()
            }
            self.mjpegClients.removeAll()
            self.wsSessions.removeAll()
        }
    }
}

/// Represents a single MJPEG streaming client with a continuation-based writer.
final class MJPEGClient {
    let id: Int
    private var writer: ((Data) -> Bool)?
    private let boundary = "frame"
    private var closed = false

    init(id: Int) {
        self.id = id
    }

    func setWriter(_ writer: @escaping (Data) -> Bool) {
        self.writer = writer
    }

    func send(frame jpegData: Data) {
        guard !closed, let writer = writer else { return }
        var chunk = Data()
        let header = "--\(boundary)\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpegData.count)\r\n\r\n"
        chunk.append(Data(header.utf8))
        chunk.append(jpegData)
        chunk.append(Data("\r\n".utf8))
        if !writer(chunk) {
            closed = true
        }
    }

    func close() {
        closed = true
        writer = nil
    }
}
