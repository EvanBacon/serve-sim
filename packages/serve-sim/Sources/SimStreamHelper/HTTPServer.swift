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

    func start() throws {
        // MJPEG stream endpoint
        server["/stream.mjpeg"] = { [weak self] request in
            guard let self else { return .notFound }

            let client = self.clientManager.addMJPEGClient()

            // WebKit (Safari/iOS Safari/WKWebView) refuses to expose a
            // multipart/x-mixed-replace response body to fetch()'s
            // ReadableStream — reader.read() rejects with "Load failed" on
            // the first chunk. Consumers that read the stream via fetch()
            // (rather than <img>) can opt in to a plain byte stream by
            // requesting ?raw=1; the JPEG frames on the wire are unchanged.
            let raw = request.queryParams.contains { $0.0 == "raw" && $0.1 == "1" }
            let contentType = raw
                ? "application/octet-stream"
                : "multipart/x-mixed-replace; boundary=frame"

            return .raw(200, "OK", [
                "Content-Type": contentType,
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

        // Config endpoint (must send CORS — preview UI is often http://localhost:* while helper is http://127.0.0.1:*)
        server["/config"] = { [weak self] _ in
            let w = self?.clientManager.screenWidth ?? 0
            let h = self?.clientManager.screenHeight ?? 0
            let obj: [String: Int] = ["width": w, "height": h]
            guard let jsonData = try? JSONSerialization.data(withJSONObject: obj) else {
                return HttpResponse.raw(500, "Internal Server Error", [
                    "Access-Control-Allow-Origin": "*",
                ]) { _ in }
            }
            let bytes = [UInt8](jsonData)
            return HttpResponse.raw(200, "OK", [
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            ]) { writer in
                try writer.write(bytes)
            }
        }

        // Health endpoint
        server["/health"] = { _ in
            let obj: [String: String] = ["status": "ok"]
            guard let jsonData = try? JSONSerialization.data(withJSONObject: obj) else {
                return HttpResponse.raw(500, "Internal Server Error", [
                    "Access-Control-Allow-Origin": "*",
                ]) { _ in }
            }
            let bytes = [UInt8](jsonData)
            return HttpResponse.raw(200, "OK", [
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            ]) { writer in
                try writer.write(bytes)
            }
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
