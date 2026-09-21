import XCTest
@testable import SimNativeSupport

final class DevicePoseTests: XCTestCase {
    func testTouchTargetsFollowPanelIncludingRotation() {
        XCTAssertEqual(DevicePose.touchTarget(width: 1398, height: 2034), 0x40000001)
        XCTAssertEqual(DevicePose.touchTarget(width: 2034, height: 1398), 0x40000001)
        XCTAssertEqual(DevicePose.touchTarget(width: 2007, height: 2853), 0x40000003)
        XCTAssertEqual(DevicePose.touchTarget(width: 2853, height: 2007), 0x40000003)
        XCTAssertNil(DevicePose.touchTarget(width: 720, height: 480))
        XCTAssertNil(DevicePose.touchTarget(width: 0, height: 0))
    }

    func testClosedPoseUsesCoverDisplay() {
        let pose = DevicePose.preset(named: "closed")
        XCTAssertEqual(pose?.hingeDegrees, 0)
        XCTAssertEqual(pose?.coverActive, true)
        XCTAssertEqual(pose?.preferredWidth, 1398)
        XCTAssertEqual(pose?.preferredHeight, 2034)
    }

    func testOpenPoseUsesInnerDisplay() {
        let pose = DevicePose.preset(named: "open")
        XCTAssertEqual(pose?.hingeDegrees, 180)
        XCTAssertEqual(pose?.coverActive, false)
        XCTAssertEqual(pose?.preferredWidth, 2007)
        XCTAssertEqual(pose?.preferredHeight, 2853)
    }

    func testCoverAndInnerAliases() {
        XCTAssertEqual(DevicePose.preset(named: "cover")?.name, "closed")
        XCTAssertEqual(DevicePose.preset(named: "inner")?.name, "open")
        XCTAssertEqual(DevicePose.preset(named: "flat")?.name, "open")
    }

    func testBookAndTableUseInnerWhileTentUsesCover() {
        XCTAssertEqual(DevicePose.preset(named: "book")?.coverActive, false)
        XCTAssertEqual(DevicePose.preset(named: "tent")?.coverActive, true)
        XCTAssertEqual(DevicePose.preset(named: "tabletop")?.coverActive, false)
    }

    func testCoverActiveThreshold() {
        XCTAssertTrue(DevicePose.spec(hingeDegrees: 0).coverActive)
        XCTAssertTrue(DevicePose.spec(hingeDegrees: 89).coverActive)
        XCTAssertFalse(DevicePose.spec(hingeDegrees: 90).coverActive)
        XCTAssertFalse(DevicePose.spec(hingeDegrees: 180).coverActive)
    }
}
