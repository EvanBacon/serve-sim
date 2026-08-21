import ApplicationServices
import AppKit
import CoreGraphics
import Foundation
import SimNativeSupport

/// Keyboard transport used by Xcode 27's Device Hub.
///
/// CoreSimulator still accepts legacy Indigo keyboard messages on Xcode 27,
/// but the iOS 27 guest no longer consumes them. Device Hub owns the new input
/// route, so this bridge posts ordinary macOS key events to its process and lets
/// the selected simulator window forward them. Xcode 26 and older never create
/// the bridge and continue using Indigo unchanged.
///
/// CGEvent can target an application, not one of its windows. To avoid typing
/// into a different simulator, the first key-down is accepted only when the
/// target device name identifies one visible, focused Device Hub window through
/// Accessibility. Accessibility titles remain available when CGWindow titles
/// are redacted without Screen Recording permission. The route remains latched
/// until every posted key is released, so one chord never splits between Device
/// Hub and the legacy Indigo fallback.
final class DeviceHubKeyboardBridge {
    private static let bundleIdentifier = "com.apple.dt.Devices"
    private static let minimumXcodeMajorVersion = 27

    private struct ActiveTarget {
        let processIdentifier: pid_t
    }

    private let expectedBundleURL: URL
    private let deviceUDID: String
    private let deviceName: String
    private let targetWindowTitle: String

    private var activeTarget: ActiveTarget?
    private var pressedUsages = Set<UInt32>()
    private var lastUnavailableReason: String?

    private init(
        expectedBundleURL: URL,
        deviceUDID: String,
        deviceName: String,
        runtimeName: String
    ) {
        self.expectedBundleURL = expectedBundleURL.resolvingSymlinksInPath().standardizedFileURL
        self.deviceUDID = deviceUDID
        self.deviceName = deviceName
        self.targetWindowTitle = "\(deviceName) – \(runtimeName)"
    }

    static func makeIfSupported(
        deviceUDID: String,
        deviceName: String,
        runtimeName: String?
    ) -> DeviceHubKeyboardBridge? {
        let environment = ProcessInfo.processInfo.environment
        guard !DeviceHubKeyboardConfiguration.isDisabled(
            environmentValue: environment["SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD"]
        ) else {
            return nil
        }

        let developerURL = URL(fileURLWithPath: Xcode.developerDir(), isDirectory: true)
        let xcodeURL = developerURL
            .deletingLastPathComponent() // Contents
            .deletingLastPathComponent() // Xcode.app

        guard let bundle = Bundle(url: xcodeURL), xcodeMajorVersion(in: bundle) >= minimumXcodeMajorVersion else {
            return nil
        }

        let deviceHubURL = xcodeURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("Applications", isDirectory: true)
            .appendingPathComponent("DeviceHub.app", isDirectory: true)
        guard FileManager.default.fileExists(atPath: deviceHubURL.path) else { return nil }

        guard let runtimeName, !runtimeName.isEmpty else { return nil }
        return DeviceHubKeyboardBridge(
            expectedBundleURL: deviceHubURL,
            deviceUDID: deviceUDID,
            deviceName: deviceName,
            runtimeName: runtimeName
        )
    }

    /// Returns true only when this event was posted through the guarded Device
    /// Hub route. False lets HIDInjector use Indigo for backward compatibility
    /// and for usages Device Hub cannot safely route.
    func send(type: String, usage: UInt32) -> Bool {
        let keyDown: Bool
        switch type {
        case "down": keyDown = true
        case "up": keyDown = false
        default: return false
        }

        guard let rawKeyCode = HIDKeyboardMapping.macVirtualKeyCode(for: usage) else { return false }
        guard CGPreflightPostEventAccess() else {
            return unavailable(
                "macOS Accessibility permission is not granted "
                + "(System Settings > Privacy & Security > Accessibility)"
            )
        }
        let keyCode = CGKeyCode(rawKeyCode)

        let target: ActiveTarget
        if keyDown {
            if let activeTarget {
                guard isExpectedDeviceHubRunning(processIdentifier: activeTarget.processIdentifier) else {
                    resetSequence()
                    return unavailable("Device Hub exited during a key sequence")
                }
                target = activeTarget
            } else {
                guard let resolved = resolveTarget() else { return false }
                activeTarget = resolved
                target = resolved
            }
        } else {
            // An up event whose down used Indigo must stay on Indigo too.
            guard pressedUsages.contains(usage), let activeTarget else { return false }
            guard isExpectedDeviceHubRunning(processIdentifier: activeTarget.processIdentifier) else {
                resetSequence()
                return unavailable("Device Hub exited during a key sequence")
            }
            target = activeTarget
        }

        var nextPressedUsages = pressedUsages
        if keyDown {
            nextPressedUsages.insert(usage)
        } else {
            nextPressedUsages.remove(usage)
        }

        guard
            let source = CGEventSource(stateID: .hidSystemState),
            let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: keyDown)
        else {
            if pressedUsages.isEmpty { resetSequence() }
            return unavailable("CoreGraphics could not create a keyboard event")
        }

        event.flags = Self.eventFlags(for: nextPressedUsages)
        event.postToPid(target.processIdentifier)

        pressedUsages = nextPressedUsages
        lastUnavailableReason = nil
        if pressedUsages.isEmpty { resetSequence() }
        return true
    }

    private func resolveTarget() -> ActiveTarget? {
        let applications = runningDeviceHubs()
        guard applications.count == 1, let application = applications.first else {
            let reason = applications.isEmpty
                ? "Device Hub from the selected Xcode is not running"
                : "multiple matching Device Hub processes are running"
            _ = unavailable(reason)
            return nil
        }

        let processIdentifier = application.processIdentifier
        let route = DeviceHubWindowRouter.route(
            windows: Self.visibleWindows(processIdentifier: processIdentifier),
            processIdentifier: processIdentifier,
            targetWindowTitle: targetWindowTitle
        )
        switch route {
        case .success:
            return ActiveTarget(processIdentifier: processIdentifier)
        case .failure(let failure):
            _ = unavailable(failure.description)
            return nil
        }
    }

    private func runningDeviceHubs() -> [NSRunningApplication] {
        NSRunningApplication
            .runningApplications(withBundleIdentifier: Self.bundleIdentifier)
            .filter { application in
                guard !application.isTerminated, let bundleURL = application.bundleURL else { return false }
                return bundleURL.resolvingSymlinksInPath().standardizedFileURL == expectedBundleURL
            }
    }

    private func isExpectedDeviceHubRunning(processIdentifier: pid_t) -> Bool {
        runningDeviceHubs().contains { $0.processIdentifier == processIdentifier }
    }

    /// Return visible standard Device Hub windows with its key window first.
    /// AX is already covered by the event-posting Accessibility permission and,
    /// unlike CGWindowList, does not require Screen Recording to expose titles.
    private static func visibleWindows(processIdentifier: pid_t) -> [DeviceHubWindow] {
        let application = AXUIElementCreateApplication(processIdentifier)
        guard
            let windows: [AXUIElement] = accessibilityValue(
                kAXWindowsAttribute,
                from: application
            ),
            let focusedWindow: AXUIElement = accessibilityValue(
                kAXFocusedWindowAttribute,
                from: application
            ),
            windows.contains(where: { CFEqual($0, focusedWindow) }),
            isVisibleStandardWindow(focusedWindow) == true
        else {
            return []
        }

        let orderedWindows = [focusedWindow] + windows.filter { !CFEqual($0, focusedWindow) }
        var snapshot = [DeviceHubWindow]()
        for (index, window) in orderedWindows.enumerated() {
            // A partial AX snapshot is unsafe: dropping an unreadable focused
            // window would make a different window appear to own keyboard focus.
            guard
                let isVisible = isVisibleStandardWindow(window),
                let title: String = accessibilityValue(kAXTitleAttribute, from: window)
            else { return [] }
            guard isVisible else { continue }
            snapshot.append(DeviceHubWindow(
                processIdentifier: processIdentifier,
                // The router only needs stable identity within this snapshot.
                windowNumber: UInt32(index + 1),
                name: title
            ))
        }
        return snapshot
    }

    private static func isVisibleStandardWindow(_ window: AXUIElement) -> Bool? {
        guard
            let role: String = accessibilityValue(kAXRoleAttribute, from: window),
            let subrole: String = accessibilityValue(kAXSubroleAttribute, from: window),
            let minimized: Bool = accessibilityValue(kAXMinimizedAttribute, from: window)
        else { return nil }
        return role == kAXWindowRole && subrole == kAXStandardWindowSubrole && !minimized
    }

    private static func accessibilityValue<T>(
        _ attribute: String,
        from element: AXUIElement
    ) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value as? T
    }

    private func unavailable(_ reason: String) -> Bool {
        if lastUnavailableReason != reason {
            let shortUDID = String(deviceUDID.prefix(8))
            print(
                "[hid] Device Hub keyboard unavailable for \(deviceName) (\(shortUDID)): "
                + "\(reason); using legacy HID"
            )
            lastUnavailableReason = reason
        }
        return false
    }

    private func resetSequence() {
        activeTarget = nil
        pressedUsages.removeAll()
    }

    private static func eventFlags(for usages: Set<UInt32>) -> CGEventFlags {
        var flags: CGEventFlags = []
        for usage in usages {
            switch HIDKeyboardMapping.modifier(for: usage) {
            case .control: flags.insert(.maskControl)
            case .shift: flags.insert(.maskShift)
            case .option: flags.insert(.maskAlternate)
            case .command: flags.insert(.maskCommand)
            case nil: break
            }
        }
        return flags
    }

    private static func xcodeMajorVersion(in bundle: Bundle) -> Int {
        if
            let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            let major = Int(version.split(separator: ".").first ?? "")
        {
            return major
        }

        if let dtxcode = bundle.object(forInfoDictionaryKey: "DTXcode") as? String,
           let value = Int(dtxcode) {
            return value / 100
        }
        if let dtxcode = bundle.object(forInfoDictionaryKey: "DTXcode") as? NSNumber {
            return dtxcode.intValue / 100
        }
        return 0
    }
}
