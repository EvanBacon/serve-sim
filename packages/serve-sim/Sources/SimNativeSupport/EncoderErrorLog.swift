import Foundation

/// Names for the VideoToolbox OSStatus values an encoder session can return.
/// Kept as a table (not VideoToolbox imports) so it stays testable anywhere.
public enum VideoToolboxStatus {
    private static let names: [Int32: String] = [
        -12900: "kVTPropertyNotSupportedErr",
        -12901: "kVTPropertyReadOnlyErr",
        -12902: "kVTParameterErr",
        -12903: "kVTInvalidSessionErr",
        -12904: "kVTAllocationFailedErr",
        -12905: "kVTPixelTransferNotSupportedErr",
        -12906: "kVTCouldNotFindVideoDecoderErr",
        -12907: "kVTCouldNotCreateInstanceErr",
        -12908: "kVTCouldNotFindVideoEncoderErr",
        -12912: "kVTVideoEncoderMalfunctionErr",
        -12915: "kVTVideoEncoderNotAvailableNowErr",
        -12916: "kVTFormatDescriptionChangeNotSupportedErr",
        -12211: "kVTVideoEncoderAuthorizationErr",
        -12218: "kVTPixelTransferNotPermittedErr",
        -17691: "kVTSessionMalfunctionErr",
        -17693: "kVTVideoEncoderNeedsRosettaErr",
    ]

    public static func name(_ status: Int32) -> String? { names[status] }

    /// "kVTPixelTransferNotSupportedErr (-12905)", or "OSStatus -1" when unknown.
    public static func describe(_ status: Int32) -> String {
        if let name = names[status] { return "\(name) (\(status))" }
        return "OSStatus \(status)"
    }
}

public struct EncoderErrorKey: Hashable, Sendable {
    public let codec: String
    public let error: String
    public let width: Int
    public let height: Int

    public init(codec: String, error: String, width: Int, height: Int) {
        self.codec = codec
        self.error = error
        self.width = width
        self.height = height
    }

    var line: String { "[capture] \(codec) encode failed at \(width)x\(height): \(error)" }
}

/// Collapses a per-frame encoder error into one line plus periodic counts.
/// The first failure for a key prints immediately. Repeats are counted and
/// summarized every `summaryInterval` seconds, when the key changes, or when
/// encoding recovers. Time is injected so the policy is unit-testable.
public struct EncoderErrorLog: Sendable {
    public let summaryInterval: Double
    private var key: EncoderErrorKey?
    private var suppressed = 0
    private var windowStart: Double = 0

    public init(summaryInterval: Double = 10) {
        self.summaryInterval = summaryInterval
    }

    /// True between a recorded failure and the next `recovered`.
    public var isFailing: Bool { key != nil }

    public mutating func record(_ next: EncoderErrorKey, at now: Double) -> [String] {
        if key == next {
            suppressed += 1
            guard now - windowStart >= summaryInterval else { return [] }
            return [summary(at: now)]
        }
        var lines: [String] = []
        if key != nil, suppressed > 0 { lines.append(summary(at: now)) }
        key = next
        suppressed = 0
        windowStart = now
        lines.append(next.line)
        return lines
    }

    /// A successful encode ends the run; report anything still uncounted.
    public mutating func recovered(at now: Double) -> [String] {
        guard key != nil else { return [] }
        let lines = suppressed > 0 ? [summary(at: now, suffix: "; recovered")] : []
        key = nil
        suppressed = 0
        return lines
    }

    private mutating func summary(at now: Double, suffix: String = "") -> String {
        let seconds = max(0, now - windowStart)
        let line = "\(key!.line) repeated \(suppressed)x in \(String(format: "%.1f", seconds))s\(suffix)"
        suppressed = 0
        windowStart = now
        return line
    }
}

/// One `EncoderErrorLog` per codec. The MJPEG and AVCC consumers share a
/// capture engine, so a success on one codec must not end (and reset the
/// suppression of) a failure run on the other.
public struct CodecEncoderErrorLogs: Sendable {
    public let summaryInterval: Double
    private var logs: [String: EncoderErrorLog] = [:]

    public init(summaryInterval: Double = 10) {
        self.summaryInterval = summaryInterval
    }

    public func isFailing(codec: String) -> Bool {
        logs[codec]?.isFailing ?? false
    }

    public mutating func record(_ next: EncoderErrorKey, at now: Double) -> [String] {
        logs[next.codec, default: EncoderErrorLog(summaryInterval: summaryInterval)].record(next, at: now)
    }

    public mutating func recovered(codec: String, at now: Double) -> [String] {
        guard isFailing(codec: codec) else { return [] }
        return logs[codec]!.recovered(at: now)
    }
}
