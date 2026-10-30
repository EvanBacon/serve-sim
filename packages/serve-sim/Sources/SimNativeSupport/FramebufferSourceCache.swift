/// Caches the framebuffer source (descriptor + IOSurface) that capture reads.
///
/// Resolving it means calling `framebufferSurface` on every display descriptor,
/// and each call is a synchronous XPC round-trip into CoreSimulatorService
/// (~2 ms each, 4 descriptors on an iPhone). Doing that on every frame callback
/// put ~5 ms on the capture path of every frame. SimulatorKit keeps the same
/// surface across frames and fires `surfacesChanged` when it swaps it, so frame
/// callbacks reuse the cached source; everything else (surface changes, idle
/// ticks, Duo panel/size changes) re-resolves. Frames reported by a descriptor
/// other than the cached one re-resolve at most every 100 ms (another display
/// became live), and a busy stream re-resolves every `maxAge` seconds as a
/// safety net.
public struct FramebufferSourceCache<Source> {
    public enum Trigger: Sendable {
        /// Frame callback from the cached source's descriptor.
        case frame
        /// Frame callback from any other descriptor.
        case otherDescriptorFrame
        case surfacesChanged
        case idleTick
        case preferredSizeChanged
    }

    private let maxAge: Double
    static var otherDescriptorMaxAge: Double { 0.1 }
    private var cached: Source?
    private var resolvedAt = -Double.infinity

    public init(maxAge: Double) {
        self.maxAge = maxAge
    }

    public var current: Source? { cached }

    public mutating func source(for trigger: Trigger, now: Double, resolve: () -> Source?) -> Source? {
        let age = now - resolvedAt
        if let cached {
            switch trigger {
            case .frame where age < maxAge,
                 .otherDescriptorFrame where age < Self.otherDescriptorMaxAge:
                return cached
            default:
                break
            }
        } else if trigger == .frame || trigger == .otherDescriptorFrame, age < Self.otherDescriptorMaxAge {
            // The last resolve failed; don't repeat its XPC on every frame.
            return nil
        }
        cached = resolve()
        resolvedAt = now
        return cached
    }

    public mutating func invalidate() {
        cached = nil
        resolvedAt = -Double.infinity
    }
}
