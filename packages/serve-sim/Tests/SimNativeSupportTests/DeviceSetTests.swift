import XCTest
@testable import SimNativeSupport

final class DeviceSetTests: XCTestCase {
    func testUnsetMeansXcodesDefaultSet() {
        XCTAssertNil(DeviceSet.path(in: [:]))
        XCTAssertNil(DeviceSet.path(in: [DeviceSet.environmentKey: " "]))
        XCTAssertEqual(
            DeviceSet.simctlArguments(["launch", "UDID", "com.apple.springboard"], environment: [:]),
            ["simctl", "launch", "UDID", "com.apple.springboard"]
        )
    }

    func testConfiguredSetGoesBeforeTheVerb() {
        let environment = [DeviceSet.environmentKey: "/pool/devices"]
        XCTAssertEqual(DeviceSet.path(in: environment), "/pool/devices")
        XCTAssertEqual(
            DeviceSet.simctlArguments(["spawn", "UDID", "/tmp/tool"], environment: environment),
            ["simctl", "--set", "/pool/devices", "spawn", "UDID", "/tmp/tool"]
        )
    }
}
