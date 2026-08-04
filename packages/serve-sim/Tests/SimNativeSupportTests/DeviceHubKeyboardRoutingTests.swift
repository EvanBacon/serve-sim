import XCTest
@testable import SimNativeSupport

final class DeviceHubKeyboardRoutingTests: XCTestCase {
    private let pid: Int32 = 42

    func testRoutesOnlyVisibleTargetWindow() throws {
        let target = window(number: 10, name: "iPhone 17 Pro")
        let routed = try DeviceHubWindowRouter.route(
            windows: [target],
            processIdentifier: pid,
            targetDeviceName: "iPhone 17 Pro"
        ).get()

        XCTAssertEqual(routed, target)
    }

    func testRoutesFrontmostTargetAmongMultipleSimulatorWindows() throws {
        let target = window(number: 10, name: "iPhone 17 Pro")
        let other = window(number: 11, name: "iPad Air")
        let routed = try DeviceHubWindowRouter.route(
            windows: [target, other],
            processIdentifier: pid,
            targetDeviceName: "iPhone 17 Pro"
        ).get()

        XCTAssertEqual(routed, target)
    }

    func testRejectsTargetThatIsNotFrontmost() {
        let result = DeviceHubWindowRouter.route(
            windows: [
                window(number: 11, name: "iPad Air"),
                window(number: 10, name: "iPhone 17 Pro"),
            ],
            processIdentifier: pid,
            targetDeviceName: "iPhone 17 Pro"
        )

        XCTAssertEqual(result.failure, .targetNotFrontmost(frontmostName: "iPad Air"))
    }

    func testRejectsDuplicateDeviceNames() {
        let result = DeviceHubWindowRouter.route(
            windows: [
                window(number: 10, name: "iPhone 17 Pro"),
                window(number: 11, name: "iPhone 17 Pro"),
            ],
            processIdentifier: pid,
            targetDeviceName: "iPhone 17 Pro"
        )

        XCTAssertEqual(result.failure, .ambiguousTarget(count: 2))
    }

    func testIgnoresHiddenUtilityAndOtherProcessWindows() {
        let result = DeviceHubWindowRouter.route(
            windows: [
                window(number: 1, name: "iPhone 17 Pro", layer: 1),
                window(number: 2, name: "iPhone 17 Pro", isOnScreen: false),
                DeviceHubWindow(
                    processIdentifier: 99,
                    windowNumber: 3,
                    name: "iPhone 17 Pro"
                ),
            ],
            processIdentifier: pid,
            targetDeviceName: "iPhone 17 Pro"
        )

        XCTAssertEqual(result.failure, .noEligibleWindows)
    }

    func testKeyboardUsageMappingIncludesModifiersAndRejectsUnknownUsage() {
        XCTAssertEqual(HIDKeyboardMapping.macVirtualKeyCode(for: 0x04), 0)
        XCTAssertEqual(HIDKeyboardMapping.macVirtualKeyCode(for: 0x2A), 51)
        XCTAssertEqual(HIDKeyboardMapping.modifier(for: 0xE1), .shift)
        XCTAssertNil(HIDKeyboardMapping.macVirtualKeyCode(for: 0xFFFF))
        XCTAssertNil(HIDKeyboardMapping.modifier(for: 0x04))
    }

    private func window(
        number: UInt32,
        name: String,
        layer: Int = 0,
        isOnScreen: Bool = true
    ) -> DeviceHubWindow {
        DeviceHubWindow(
            processIdentifier: pid,
            windowNumber: number,
            name: name,
            layer: layer,
            isOnScreen: isOnScreen
        )
    }
}

private extension Result {
    var failure: Failure? {
        guard case .failure(let error) = self else { return nil }
        return error
    }
}
