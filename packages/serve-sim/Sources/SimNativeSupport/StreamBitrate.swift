/// Average bitrate for the H.264 preview stream.
///
/// A fixed 6 Mbps starved full-resolution iPhone screens (1206x2622 @ 60 fps
/// is ~0.03 bits/pixel): under full-screen motion VideoToolbox's low-latency
/// rate control dropped to ~15 fps and frames queued for 700+ ms. Scale with
/// the pixel rate instead (0.1 bits/pixel, ~19 Mbps for an iPhone Pro). Simple
/// UI content still encodes far below the target; the cap bounds iPad-sized
/// screens for viewers on a LAN.
public enum StreamBitrate {
    public static let minimum = 6_000_000
    public static let maximum = 30_000_000
    static let bitsPerPixel = 0.1

    public static func average(width: Int, height: Int, fps: Int) -> Int {
        guard width > 0, height > 0, fps > 0 else { return minimum }
        let target = Int(Double(width * height * fps) * bitsPerPixel)
        return min(max(target, minimum), maximum)
    }
}
