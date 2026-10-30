/// Average bitrate for screen recordings.
///
/// Recordings are archival, not latency-bound, so they get twice the live
/// stream's 0.1 bits/pixel (~38 Mbps for an iPhone Pro at 60 fps). That is a
/// ceiling, not a constant rate: static stretches are repeated frames that
/// encode to skip blocks, so typical UI recordings land far below it.
public enum RecordingBitrate {
    public static let minimum = 8_000_000
    public static let maximum = 80_000_000
    static let bitsPerPixel = 0.2

    public static func average(width: Int, height: Int, fps: Int) -> Int {
        guard width > 0, height > 0, fps > 0 else { return minimum }
        let target = Int(Double(width * height * fps) * bitsPerPixel)
        return min(max(target, minimum), maximum)
    }
}
