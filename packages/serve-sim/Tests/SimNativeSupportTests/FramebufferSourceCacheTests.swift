import XCTest
@testable import SimNativeSupport

final class FramebufferSourceCacheTests: XCTestCase {
    private final class Resolver {
        var calls = 0
        var next: String? = "surface-A"
        func resolve() -> String? { calls += 1; return next }
    }

    func testFrameCallbacksReuseTheCachedSource() {
        var cache = FramebufferSourceCache<String>(maxAge: 1.0)
        let r = Resolver()
        XCTAssertEqual(cache.source(for: .frame, now: 0, resolve: r.resolve), "surface-A")
        XCTAssertEqual(cache.source(for: .frame, now: 0.016, resolve: r.resolve), "surface-A")
        XCTAssertEqual(cache.source(for: .frame, now: 0.5, resolve: r.resolve), "surface-A")
        XCTAssertEqual(r.calls, 1)
    }

    func testSurfaceChangesIdleTicksAndSizeChangesReresolve() {
        var cache = FramebufferSourceCache<String>(maxAge: 1.0)
        let r = Resolver()
        _ = cache.source(for: .frame, now: 0, resolve: r.resolve)
        r.next = "surface-B"
        XCTAssertEqual(cache.source(for: .surfacesChanged, now: 0.1, resolve: r.resolve), "surface-B")
        XCTAssertEqual(cache.source(for: .idleTick, now: 0.2, resolve: r.resolve), "surface-B")
        XCTAssertEqual(cache.source(for: .preferredSizeChanged, now: 0.3, resolve: r.resolve), "surface-B")
        XCTAssertEqual(r.calls, 4)
    }

    func testBusyStreamsStillReresolvePeriodically() {
        var cache = FramebufferSourceCache<String>(maxAge: 1.0)
        let r = Resolver()
        _ = cache.source(for: .frame, now: 0, resolve: r.resolve)
        r.next = "surface-B"
        XCTAssertEqual(cache.source(for: .frame, now: 0.99, resolve: r.resolve), "surface-A")
        XCTAssertEqual(cache.source(for: .frame, now: 1.0, resolve: r.resolve), "surface-B")
        XCTAssertEqual(r.calls, 2)
    }

    func testAMissingSourceIsRetriedOnTheNextFrame() {
        var cache = FramebufferSourceCache<String>(maxAge: 1.0)
        let r = Resolver()
        r.next = nil
        XCTAssertNil(cache.source(for: .frame, now: 0, resolve: r.resolve))
        r.next = "surface-A"
        XCTAssertEqual(cache.source(for: .frame, now: 0.016, resolve: r.resolve), "surface-A")
        XCTAssertEqual(r.calls, 2)
    }

    func testInvalidateDropsTheCachedSource() {
        var cache = FramebufferSourceCache<String>(maxAge: 1.0)
        let r = Resolver()
        _ = cache.source(for: .frame, now: 0, resolve: r.resolve)
        cache.invalidate()
        _ = cache.source(for: .frame, now: 0.016, resolve: r.resolve)
        XCTAssertEqual(r.calls, 2)
    }

    func testFramesFromAnotherDescriptorReresolveAtMostEvery100ms() {
        var cache = FramebufferSourceCache<String>(maxAge: 1.0)
        let r = Resolver()
        _ = cache.source(for: .frame, now: 0, resolve: r.resolve)
        r.next = "surface-B"
        XCTAssertEqual(cache.source(for: .otherDescriptorFrame, now: 0.05, resolve: r.resolve), "surface-A")
        XCTAssertEqual(cache.source(for: .otherDescriptorFrame, now: 0.1, resolve: r.resolve), "surface-B")
        XCTAssertEqual(cache.source(for: .otherDescriptorFrame, now: 0.15, resolve: r.resolve), "surface-B")
        XCTAssertEqual(r.calls, 2)
    }

    func testCurrentExposesTheCachedSource() {
        var cache = FramebufferSourceCache<String>(maxAge: 1.0)
        XCTAssertNil(cache.current)
        _ = cache.source(for: .frame, now: 0, resolve: { "surface-A" })
        XCTAssertEqual(cache.current, "surface-A")
        cache.invalidate()
        XCTAssertNil(cache.current)
    }
}
