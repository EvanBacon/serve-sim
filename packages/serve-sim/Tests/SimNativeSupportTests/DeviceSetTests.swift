import XCTest
@testable import SimNativeSupport

final class DeviceSetTests: XCTestCase {
    override func tearDown() {
        DeviceSet.configure(path: nil)
        super.tearDown()
    }

    func testUnsetMeansXcodesDefaultSet() {
        XCTAssertNil(DeviceSet.path())
        XCTAssertEqual(
            DeviceSet.simctlArguments(["launch", "UDID", "com.apple.springboard"]),
            ["simctl", "launch", "UDID", "com.apple.springboard"]
        )
    }

    func testConfiguredSetGoesBeforeTheVerb() {
        DeviceSet.configure(path: "/pool/devices")
        XCTAssertEqual(DeviceSet.path(), "/pool/devices")
        XCTAssertEqual(
            DeviceSet.simctlArguments(["spawn", "UDID", "/tmp/tool"]),
            ["simctl", "--set", "/pool/devices", "spawn", "UDID", "/tmp/tool"]
        )
        DeviceSet.configure(path: nil)
        XCTAssertNil(DeviceSet.path())
    }
}
