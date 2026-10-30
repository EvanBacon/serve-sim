import XCTest
@testable import SimNativeSupport

final class SurfaceFrameStampTests: XCTestCase {
    func testSameSurfaceAndSeedIsUnchanged() {
        XCTAssertEqual(
            SurfaceFrameStamp(surfaceID: 7, seed: 3),
            SurfaceFrameStamp(surfaceID: 7, seed: 3)
        )
    }

    func testSeedChangeOnSameSurfaceIsChanged() {
        XCTAssertNotEqual(
            SurfaceFrameStamp(surfaceID: 7, seed: 3),
            SurfaceFrameStamp(surfaceID: 7, seed: 4)
        )
    }

    func testReplacedSurfaceWithEqualSeedIsChanged() {
        XCTAssertNotEqual(
            SurfaceFrameStamp(surfaceID: 7, seed: 3),
            SurfaceFrameStamp(surfaceID: 8, seed: 3)
        )
    }
}
