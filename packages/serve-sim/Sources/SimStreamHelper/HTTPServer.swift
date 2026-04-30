import Foundation
import Swifter

/// HTTP + WebSocket server using Swifter library.
/// Serves MJPEG stream on /stream.mjpeg, WebSocket on /ws for input.
final class HTTPServer {
    let clientManager = ClientManager()
    private let server = HttpServer()
    private let port: UInt16

    init(port: UInt16 = 3100) {
        self.port = port
    }

    private func jsonResponse(_ object: AnyObject) -> HttpResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return .raw(200, "OK", [
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        ]) { writer in
            try writer.write(data)
        }
    }

    func start() throws {
        // MJPEG stream endpoint
        server["/stream.mjpeg"] = { [weak self] request in
            guard let self else { return .notFound }

            let client = self.clientManager.addMJPEGClient()

            return .raw(200, "OK", [
                "Content-Type": "multipart/x-mixed-replace; boundary=frame",
                "Cache-Control": "no-cache, no-store",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            ]) { writer in
                let semaphore = DispatchSemaphore(value: 0)

                client.setWriter { data in
                    do {
                        try writer.write(data)
                        return true
                    } catch {
                        semaphore.signal()
                        return false
                    }
                }

                // Now that writer is attached, send the latest cached frame
                self.clientManager.sendLatestFrame(to: client)

                // Block until the client disconnects
                semaphore.wait()
                self.clientManager.removeMJPEGClient(client)
            }
        }

        // WebSocket endpoint (input only)
        server["/ws"] = websocket(
            binary: { [weak self] session, data in
                self?.clientManager.handleMessage(from: session, data: Data(data))
            },
            connected: { [weak self] session in
                self?.clientManager.addWSClient(session)
            },
            disconnected: { [weak self] session in
                self?.clientManager.removeWSClient(session)
            }
        )

        // Config endpoint
        server["/config"] = { [weak self] request in
            guard let self else { return .notFound }
            let snapshot = self.clientManager.streamSnapshot()
            return self.jsonResponse([
                "width": snapshot.width,
                "height": snapshot.height,
                "hasFrame": snapshot.hasFrame,
                "frameSequence": snapshot.frameSequence,
            ] as AnyObject)
        }

        // Health endpoint
        server["/health"] = { [weak self] _ in
            return self?.jsonResponse(["status": "ok"] as AnyObject) ?? .notFound
        }

        // CORS preflight
        server.middleware.append { request in
            if request.method == "OPTIONS" {
                return HttpResponse.raw(204, "No Content", [
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                ], { _ in })
            }
            return nil
        }

        try server.start(port, forceIPv4: false, priority: .userInteractive)
        print("[server] Listening on http://0.0.0.0:\(port)")
    }

    func stop() {
        clientManager.stop()
        server.stop()
    }
}
