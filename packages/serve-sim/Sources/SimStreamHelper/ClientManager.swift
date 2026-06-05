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

    /// AVCC (H.264) stream clients + the cached avcC description envelope so
    /// late joiners can configure their decoder without waiting for the next
    /// natural IDR.
    private var avccClients: [ObjectIdentifier: AVCCClient] = [:]
    private var cachedAvccDescription: Data?
    /// Fired when an AVCC client connects so the owner can force a keyframe —
    /// the new decoder needs an IDR before any delta will decode.
    var onAvccClientConnect: (() -> Void)?

    var onTouch: ((TouchEventPayload) -> Void)?
    var onButton: ((String) -> Void)?
    var onMultiTouch: ((MultiTouchEventPayload) -> Void)?
    var onKey: ((KeyEventPayload) -> Void)?
    var onOrientation: ((UInt32) -> Bool)?
    var onCADebug: ((CADebugEventPayload) -> Void)?
    var onMemoryWarning: (() -> Void)?
    var onDigitalCrown: ((DigitalCrownEventPayload) -> Void)?

    // MARK: - Configuration

    func setScreenSize(width: Int, height: Int) {
        configLock.lock()
        let changed = width != screenWidth || height != screenHeight
        screenWidth = width
        screenHeight = height
        configLock.unlock()
        if changed { broadcastConfig() }
    }

    private func setScreenOrientation(_ orientation: String) {
        configLock.lock()
        let changed = orientation != screenOrientation
        screenOrientation = orientation
        configLock.unlock()
        if changed { broadcastConfig() }
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

    /// Tag for a server->client screen-config push. Distinct from the
    /// client->server input tags (0x03–0x0A); the frame layout mirrors input:
    /// `[tag][JSON payload]`.
    private static let wsMsgConfig: UInt8 = 0x82

    private func configFrame() -> [UInt8]? {
        guard let json = try? JSONSerialization.data(withJSONObject: screenConfig()) else { return nil }
        return [ClientManager.wsMsgConfig] + [UInt8](json)
    }

    /// Push the current screen config to every connected input WebSocket. This
    /// replaces the browser's old 1s `/config` poll — clients now receive
    /// dimensions/orientation over the socket they already hold open for input.
    func broadcastConfig() {
        guard let frame = configFrame() else { return }
        queue.async {
            for (_, session) in self.wsSessions {
                session.writeBinary(frame)
            }
        }
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

    // MARK: - AVCC Client Management

    /// True when at least one viewer is consuming the H.264 stream. The owner
    /// gates VideoToolbox encoding on this so an all-MJPEG session pays no
    /// H.264 cost.
    func hasAvccClients() -> Bool {
        configLock.lock()
        defer { configLock.unlock() }
        return avccClientCount > 0
    }
    private var avccClientCount = 0

    func addAvccClient() -> AVCCClient {
        let client = AVCCClient(id: nextClientId)
        nextClientId += 1
        let key = ObjectIdentifier(client)
        configLock.lock(); avccClientCount += 1; configLock.unlock()
        queue.async {
            self.avccClients[key] = client
            print("[clients] AVCC client connected (\(self.avccClients.count) total)")
        }
        return client
    }

    /// After a client's writer is attached: paint instantly with a JPEG seed,
    /// replay the cached decoder description, then ask the owner to force a
    /// keyframe so an IDR follows promptly.
    func sendInitialAvcc(to client: AVCCClient) {
        queue.async {
            if let jpeg = self.latestFrame {
                client.send(AVCCEnvelope.seed(jpeg: jpeg))
            }
            if let desc = self.cachedAvccDescription {
                client.send(desc)
            }
        }
        onAvccClientConnect?()
    }

    func removeAvccClient(_ client: AVCCClient) {
        let key = ObjectIdentifier(client)
        configLock.lock(); avccClientCount = max(0, avccClientCount - 1); configLock.unlock()
        queue.async {
            self.avccClients.removeValue(forKey: key)
            print("[clients] AVCC client disconnected (\(self.avccClients.count) total)")
        }
    }

    /// Broadcast one enveloped AVCC chunk. Caches the description so it can be
    /// replayed to clients that connect after it was first emitted.
    func broadcastAvcc(_ envelope: Data, isDescription: Bool = false) {
        queue.async {
            if isDescription { self.cachedAvccDescription = envelope }
            for (_, client) in self.avccClients {
                client.send(envelope)
            }
        }
    }

    // MARK: - WebSocket Client Management (input only)

    func addWSClient(_ session: WebSocketSession) {
        let id = ObjectIdentifier(session)
        let frame = configFrame()
        queue.async {
            self.wsSessions[id] = session
            // Seed the new client with the current screen config so it gets
            // dimensions/orientation immediately, replacing the old 1s poll.
            if let frame = frame { session.writeBinary(frame) }
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
        } else if type == 0x0A { // WS_MSG_DIGITAL_CROWN
            guard let json = try? JSONDecoder().decode(DigitalCrownEventPayload.self, from: data[1...]) else { return }
            onDigitalCrown?(json)
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
            for (_, client) in self.avccClients {
                client.close()
            }
            self.mjpegClients.removeAll()
            self.avccClients.removeAll()
            self.wsSessions.removeAll()
        }
        configLock.lock(); avccClientCount = 0; configLock.unlock()
    }
}

/// A single AVCC streaming client. Unlike `MJPEGClient`, chunks already carry
/// their own length-prefixed envelope, so the writer just forwards raw bytes.
final class AVCCClient {
    let id: Int
    private var writer: ((Data) -> Bool)?
    private var closed = false

    init(id: Int) { self.id = id }

    func setWriter(_ writer: @escaping (Data) -> Bool) { self.writer = writer }

    func send(_ chunk: Data) {
        guard !closed, let writer = writer else { return }
        if !writer(chunk) { closed = true }
    }

    func close() {
        closed = true
        writer = nil
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
