import Foundation
import Swifter

/// HTTP + WebSocket server using Swifter library.
/// Serves MJPEG stream on /stream.mjpeg, WebSocket on /ws for input.
final class HTTPServer {
    let clientManager = ClientManager()
    private let server = HttpServer()
    private let port: UInt16
    private let deviceUDID: String
    private let corsHeaders = [
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    ]

    init(deviceUDID: String, port: UInt16 = 3100) {
        self.deviceUDID = deviceUDID
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

        // Config endpoint
        server["/config"] = { [weak self] request in
            let config: [String: Any] = self?.clientManager.screenConfig() ?? [
                "width": 0,
                "height": 0,
                "orientation": "portrait",
            ]
            return self?.jsonResponse(config) ?? .internalServerError
        }

        // Health endpoint
        server["/health"] = { [weak self] _ in
            return self?.jsonResponse(["status": "ok"]) ?? .internalServerError
        }

        // Accessibility tree (replaces a global `axe describe-ui` install).
        // Returns axe's flat-array JSON shape so the Node-side normalizer
        // in src/ax.ts works unchanged.
        server["/ax"] = { [weak self] _ in
            guard let self else { return .internalServerError }
            do {
                let data = try AccessibilityBridge.shared.describeUI(udid: self.deviceUDID)
                var headers = self.corsHeaders
                headers["Content-Type"] = "application/json"
                headers["Cache-Control"] = "no-cache, no-store"
                headers["Content-Length"] = "\(data.count)"
                return .raw(200, "OK", headers) { writer in
                    try? writer.write(data)
                }
            } catch {
                let payload: [String: Any] = [
                    "error": "ax_unavailable",
                    "message": error.localizedDescription,
                ]
                guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
                    return .internalServerError
                }
                var headers = self.corsHeaders
                headers["Content-Type"] = "application/json"
                headers["Content-Length"] = "\(body.count)"
                return .raw(503, "Service Unavailable", headers) { writer in
                    try? writer.write(body)
                }
            }
        }

        // Frontmost-app probe. Returns `{bundleId, pid}` for the visible
        // app right now — used to bootstrap `/appstate` SSE clients after
        // a page reload, since SpringBoard's foreground log is edge-only.
        server["/foreground"] = { [weak self] _ in
            guard let self else { return .internalServerError }
            do {
                let info = try AccessibilityBridge.shared.frontmostApp(udid: self.deviceUDID)
                let data = try JSONSerialization.data(withJSONObject: info)
                var headers = self.corsHeaders
                headers["Content-Type"] = "application/json"
                headers["Cache-Control"] = "no-cache, no-store"
                headers["Content-Length"] = "\(data.count)"
                return .raw(200, "OK", headers) { writer in
                    try? writer.write(data)
                }
            } catch {
                let payload: [String: Any] = [
                    "error": "foreground_unavailable",
                    "message": error.localizedDescription,
                ]
                guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
                    return .internalServerError
                }
                var headers = self.corsHeaders
                headers["Content-Type"] = "application/json"
                headers["Content-Length"] = "\(body.count)"
                return .raw(503, "Service Unavailable", headers) { writer in
                    try? writer.write(body)
                }
            }
        }

        // CORS preflight
        server.middleware.append { request in
            if request.method == "OPTIONS" {
                return HttpResponse.raw(204, "No Content", self.corsHeaders, { _ in })
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

    private func jsonResponse(_ object: [String: Any]) -> HttpResponse {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else {
            return .internalServerError
        }

        var headers = corsHeaders
        headers["Content-Type"] = "application/json"
        headers["Cache-Control"] = "no-cache, no-store"
        headers["Content-Length"] = "\(data.count)"

        return .raw(200, "OK", headers) { writer in
            try? writer.write(data)
        }
    }
}
