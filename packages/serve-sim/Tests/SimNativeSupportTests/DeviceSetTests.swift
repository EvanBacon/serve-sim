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

    func testLookUpAsksForXcodesDefaultSetWhenUnset() {
        var asked: (selector: String, path: String?)?
        let found = DeviceSet.lookUp { selector, path -> String? in
            asked = (selector, path)
            return "default set"
        }
        XCTAssertEqual(found, "default set")
        XCTAssertEqual(asked?.selector, "defaultDeviceSetWithError:")
        XCTAssertNil(asked?.path)
    }

    func testLookUpAsksForTheConfiguredSetByPath() {
        DeviceSet.configure(path: "/pool/devices")
        var asked: (selector: String, path: String?)?
        let found = DeviceSet.lookUp { selector, path -> String? in
            asked = (selector, path)
            return "pool set"
        }
        XCTAssertEqual(found, "pool set")
        XCTAssertEqual(asked?.selector, "deviceSetWithPath:error:")
        XCTAssertEqual(asked?.path, "/pool/devices")
    }

    func testLookUpIsNilWhenNoSetIsFound() {
        XCTAssertNil(DeviceSet.lookUp { _, _ -> String? in nil })
        DeviceSet.configure(path: "/pool/devices")
        XCTAssertNil(DeviceSet.lookUp { _, _ -> String? in nil })
    }
}
