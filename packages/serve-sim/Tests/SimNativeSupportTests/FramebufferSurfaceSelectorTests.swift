import XCTest
@testable import SimNativeSupport

final class FramebufferSurfaceSelectorTests: XCTestCase {
    func testExpectedDeviceSurfaceBeatsLargerPresentationSurface() {
        let candidates = [
            FramebufferSurfaceSize(width: 7680, height: 4320),
            FramebufferSurfaceSize(width: 0, height: 0),
            FramebufferSurfaceSize(width: 1206, height: 2622),
        ]

        XCTAssertEqual(
            FramebufferSurfaceSelector.select(
                from: candidates,
                expectedSize: FramebufferSurfaceSize(width: 1206, height: 2622)
            ),
            FramebufferSurfaceSelection(index: 2, matchedExpectedSize: true)
        )
    }

    func testExpectedSizeMatchesRotatedSurface() {
        XCTAssertEqual(
            FramebufferSurfaceSelector.select(
                from: [FramebufferSurfaceSize(width: 2622, height: 1206)],
                expectedSize: FramebufferSurfaceSize(width: 1206, height: 2622)
            ),
            FramebufferSurfaceSelection(index: 0, matchedExpectedSize: true)
        )
    }

    func testZeroSizedSurfacesAreIgnored() {
        XCTAssertNil(
            FramebufferSurfaceSelector.select(
                from: [
                    FramebufferSurfaceSize(width: 0, height: 0),
                    FramebufferSurfaceSize(width: 1206, height: 0),
                ],
                expectedSize: FramebufferSurfaceSize(width: 1206, height: 2622)
            )
        )
    }

    func testMissingMetadataPreservesLargestSurfaceFallback() {
        XCTAssertEqual(
            FramebufferSurfaceSelector.select(
                from: [
                    FramebufferSurfaceSize(width: 320, height: 240),
                    FramebufferSurfaceSize(width: 1179, height: 2556),
                ],
                expectedSize: nil
            ),
            FramebufferSurfaceSelection(index: 1, matchedExpectedSize: false)
        )
    }

    func testNoExactMatchPreservesLargestSurfaceFallback() {
        XCTAssertEqual(
            FramebufferSurfaceSelector.select(
                from: [
                    FramebufferSurfaceSize(width: 1000, height: 2000),
                    FramebufferSurfaceSize(width: 1100, height: 2200),
                ],
                expectedSize: FramebufferSurfaceSize(width: 1206, height: 2622)
            ),
            FramebufferSurfaceSelection(index: 1, matchedExpectedSize: false)
        )
    }
}
