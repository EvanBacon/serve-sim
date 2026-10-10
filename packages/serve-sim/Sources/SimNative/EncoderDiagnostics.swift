import Foundation
import SimNativeSupport

/// Per-capture-engine encoder counters for `serve-sim doctor`, plus the
/// collapsed encoder-error log. Touched once per failed encode, per session
/// rebuild, and (cheaply) per successful encode after a failure.
final class EncoderDiagnostics: @unchecked Sendable {
    private struct Count {
        var count: Int
        var first: Date
        var last: Date
    }

    private let lock = NSLock()
    private var log = EncoderErrorLog()
    private var failing = false
    private var errors: [EncoderErrorKey: Count] = [:]
    private var sessions: [[String: Any]] = []

    static func describe(_ error: Error) -> String {
        if let h264 = error as? H264Encoder.Errors, case .encodingFailed(let status) = h264 {
            return "encodingFailed: \(VideoToolboxStatus.describe(status))"
        }
        return String(describing: error)
    }

    func recordFailure(codec: String, error: Error, width: Int, height: Int) {
        let key = EncoderErrorKey(codec: codec, error: Self.describe(error), width: width, height: height)
        let now = Date()
        lock.lock()
        failing = true
        var entry = errors[key] ?? Count(count: 0, first: now, last: now)
        entry.count += 1
        entry.last = now
        errors[key] = entry
        let lines = log.record(key, at: now.timeIntervalSince1970)
        lock.unlock()
        for line in lines { print(line) }
    }

    func recordSuccess() {
        lock.lock()
        guard failing else { lock.unlock(); return }
        failing = false
        let lines = log.recovered(at: Date().timeIntervalSince1970)
        lock.unlock()
        for line in lines { print(line) }
    }

    func recordSession(codec: String, width: Int, height: Int, status: Int32, lowLatency: Bool) {
        lock.lock()
        let session: [String: Any] = [
            "at": isoTimestamp(Date()),
            "codec": codec,
            "width": width,
            "height": height,
            "status": Int(status),
            "status_name": status == 0 ? "noErr" : VideoToolboxStatus.describe(status),
            "low_latency": lowLatency,
        ]
        sessions.append(session)
        if sessions.count > 10 { sessions.removeFirst(sessions.count - 10) }
        lock.unlock()
    }

    func snapshot() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let errorList: [[String: Any]] = errors
            .sorted { $0.value.last > $1.value.last }
            .map { entry -> [String: Any] in
                [
                    "codec": entry.key.codec,
                    "error": entry.key.error,
                    "width": entry.key.width,
                    "height": entry.key.height,
                    "count": entry.value.count,
                    "first_at": isoTimestamp(entry.value.first),
                    "last_at": isoTimestamp(entry.value.last),
                ]
            }
        return ["sessions": sessions, "errors": errorList]
    }
}

func isoTimestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

func jsonString(_ object: Any) -> String {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let string = String(data: data, encoding: .utf8)
    else { return "{}" }
    return string
}
