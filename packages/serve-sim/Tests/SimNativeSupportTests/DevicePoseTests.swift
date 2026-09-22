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

    func testClosedAndOpenHingeAngles() {
        XCTAssertEqual(DevicePose.preset(named: "closed")?.hingeDegrees, 0)
        XCTAssertEqual(DevicePose.preset(named: "open")?.hingeDegrees, 180)
        XCTAssertEqual(DevicePose.preset(named: "book")?.hingeDegrees, 130)
        XCTAssertEqual(DevicePose.preset(named: "tent")?.hingeDegrees, 80)
        XCTAssertEqual(DevicePose.preset(named: "tabletop")?.hingeDegrees, 100)
    }

    func testCoverAndInnerAliases() {
        XCTAssertEqual(DevicePose.preset(named: "cover")?.name, "closed")
        XCTAssertEqual(DevicePose.preset(named: "inner")?.name, "open")
        XCTAssertEqual(DevicePose.preset(named: "flat")?.name, "open")
    }

}
