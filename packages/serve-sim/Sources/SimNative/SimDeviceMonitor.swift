import Foundation

// Reactive replacement for `xcrun simctl list devices`.
//
// `simctl list` is a thin CLI over CoreSimulator.framework, which itself holds
// no state: it talks to the `com.apple.CoreSimulator.CoreSimulatorService`
// launchd daemon over XPC. When CoreSimulator hands you a `SimDeviceSet` it has
// already opened an XPC subscription with that daemon, and routes pushed
// notifications through `-[SimDeviceSet handleXPCNotification:]`, which keeps
// the cached `SimDevice` objects (and their `state`) live. So once we hold the
// default device set, reading `-[SimDeviceSet devices]` / `-[SimDevice
// stateString]` is always current with zero `simctl` spawns.
//
// On top of that we register notification handlers so we can *push* changes to
// JS instead of polling:
//   • the set-level handler fires on device add / remove,
//   • a per-device handler fires on state changes (Shutdown↔Booting↔Booted).
// Any notification just triggers a full rescan of the (already-live) set — far
// simpler than decoding each XPC payload, and the set is in-memory so a rescan
// is cheap.
//
// CoreSimulator is never linked or imported (its install location is
// Xcode-version specific); it is dlopen'd by `SimFrameworks.load()` and every
// type crosses the bridge as `AnyObject`, reached through these `@objc`
// protocol shims via `unsafeBitCast` — the same runtime-only approach the rest
// of this addon (HIDInjector / AccessibilityBridge) uses.

private typealias ErrPtr = AutoreleasingUnsafeMutablePointer<NSError?>?

// `+[SimServiceContext sharedServiceContextForDeveloperDir:error:]` is a class
// method, so it's invoked on the class object (its metaclass responds to the
// selector exactly as an instance would).
@objc private protocol CSServiceContextStatics {
    @objc(sharedServiceContextForDeveloperDir:error:)
    func sharedServiceContext(forDeveloperDir dir: String, error: ErrPtr) -> AnyObject?
}

@objc private protocol CSServiceContext {
    @objc(defaultDeviceSetWithError:)
    func defaultDeviceSet(error: ErrPtr) -> AnyObject?
}

@objc private protocol CSDeviceSet {
    @objc var devices: [AnyObject] { get }
    @objc(registerNotificationHandlerOnQueue:handler:)
    func registerNotificationHandler(onQueue queue: DispatchQueue,
                                     handler: @escaping (AnyObject) -> Void) -> UInt64
}

@objc private protocol CSDevice {
    @objc(UDID) var udid: NSUUID { get }
    @objc var name: String { get }
    @objc var stateString: String { get }
    @objc var available: Bool { get }
    @objc var runtime: AnyObject? { get }
    @objc var deviceType: AnyObject? { get }
    @objc(registerNotificationHandlerOnQueue:handler:)
    func registerNotificationHandler(onQueue queue: DispatchQueue,
                                     handler: @escaping (AnyObject) -> Void) -> UInt64
}

@objc private protocol CSRuntime {
    @objc var identifier: String { get }
}

@objc private protocol CSDeviceType {
    @objc var identifier: String { get }
}

/// Raised when the CoreSimulator subscription could not be established, so the
/// N-API layer can surface a thrown error (the TS side then falls back to
/// `simctl` rather than mistaking "couldn't look up" for "no devices").
enum SimMonitorError: Error { case unavailable }

/// One simulator, in the same shape `simctl list devices -j` reports per device.
struct SimDeviceInfo {
    let udid: String
    let name: String
    /// "Creating" | "Shutdown" | "Booting" | "Booted" | "Shutting Down".
    let state: String
    let isAvailable: Bool
    /// e.g. "com.apple.CoreSimulator.SimRuntime.iOS-26-5" — the grouping key.
    let runtimeIdentifier: String
    let deviceTypeIdentifier: String
}

/// Process-global, lazily-started subscriber to the default CoreSimulator
/// device set. Pure Foundation (no NodeAPI) so it can be unit-reasoned about;
/// the N-API surface in sim-module.swift adapts it.
final class SimDeviceMonitor {
    static let shared = SimDeviceMonitor()

    /// Serializes every CoreSimulator interaction and snapshot mutation. It is
    /// also the queue notification handlers are delivered on, so handler bodies
    /// run mutually exclusive with rescans for free.
    private let queue = DispatchQueue(label: "serve-sim.simmonitor")
    /// Guards `snapshot` + `observers` for cross-thread reads (the sync
    /// `listDevices()` path reads `snapshot` from the JS thread).
    private let lock = NSLock()

    private var started = false
    private var deviceSet: AnyObject?
    private var snapshot: [SimDeviceInfo] = []
    /// Per-device handler registrations, keyed by UDID. We retain the device so
    /// its notification manager (and our handler) stays alive while it's in the
    /// set; dropping the entry on removal lets it deallocate.
    private var deviceRegs: [String: (device: AnyObject, regID: UInt64)] = [:]
    private var observers: [Int: () -> Void] = [:]
    private var nextObserverID = 0

    private init() {}

    /// Subscribe + do the initial scan. Idempotent and synchronous: the first
    /// call blocks briefly on one CoreSimulator round-trip, every later call is
    /// a no-op. Safe to call from any thread.
    func start() {
        queue.sync { self.startLocked() }
    }

    private func startLocked() {
        if started { return }
        SimFrameworks.load()

        guard let ctxClass: AnyObject = NSClassFromString("SimServiceContext") else { return }
        let statics = unsafeBitCast(ctxClass, to: CSServiceContextStatics.self)
        var err: NSError?
        guard let ctxObj = statics.sharedServiceContext(forDeveloperDir: Xcode.developerDir(),
                                                        error: &err) else { return }
        let ctx = unsafeBitCast(ctxObj, to: CSServiceContext.self)
        guard let setObj = ctx.defaultDeviceSet(error: &err) else { return }

        deviceSet = setObj
        // Fires on device add / remove. State changes arrive on the per-device
        // handlers wired up in `rescanLocked()`.
        _ = unsafeBitCast(setObj, to: CSDeviceSet.self)
            .registerNotificationHandler(onQueue: queue) { [weak self] _ in
                self?.rescanLocked()
            }
        started = true
        rescanLocked()
    }

    /// Re-read the (live, in-memory) device set, refresh per-device handler
    /// registrations, and publish + notify if anything changed. Must run on
    /// `queue` — every caller is either `startLocked()` or a handler delivered
    /// on `queue`.
    private func rescanLocked() {
        guard let setObj = deviceSet else { return }
        let devices = unsafeBitCast(setObj, to: CSDeviceSet.self).devices

        var infos: [SimDeviceInfo] = []
        infos.reserveCapacity(devices.count)
        var present = Set<String>()

        for obj in devices {
            let dev = unsafeBitCast(obj, to: CSDevice.self)
            let udid = dev.udid.uuidString
            present.insert(udid)

            var runtimeID = "unknown"
            if let rt = dev.runtime { runtimeID = unsafeBitCast(rt, to: CSRuntime.self).identifier }
            var deviceTypeID = ""
            if let dt = dev.deviceType { deviceTypeID = unsafeBitCast(dt, to: CSDeviceType.self).identifier }

            infos.append(SimDeviceInfo(udid: udid, name: dev.name, state: dev.stateString,
                                       isAvailable: dev.available, runtimeIdentifier: runtimeID,
                                       deviceTypeIdentifier: deviceTypeID))

            // Subscribe to this device's state changes exactly once.
            if deviceRegs[udid] == nil {
                let regID = dev.registerNotificationHandler(onQueue: queue) { [weak self] _ in
                    self?.rescanLocked()
                }
                deviceRegs[udid] = (obj, regID)
            }
        }

        // Forget devices that left the set (releases the device + its handler).
        for udid in deviceRegs.keys where !present.contains(udid) {
            deviceRegs.removeValue(forKey: udid)
        }

        lock.lock()
        let changed = !Self.sameSnapshot(snapshot, infos)
        snapshot = infos
        let toNotify = changed ? Array(observers.values) : []
        lock.unlock()

        for cb in toNotify { cb() }
    }

    private static func sameSnapshot(_ a: [SimDeviceInfo], _ b: [SimDeviceInfo]) -> Bool {
        if a.count != b.count { return false }
        // `devices` is sorted by CoreSimulator, so index-wise compare is stable.
        for (x, y) in zip(a, b) where x.udid != y.udid || x.state != y.state
            || x.name != y.name || x.isAvailable != y.isAvailable { return false }
        return true
    }

    /// Whether the subscription was established successfully (set only after a
    /// full `startLocked()`). A failed start leaves this false so callers can
    /// distinguish "no devices" from "couldn't reach CoreSimulator".
    var isReady: Bool { queue.sync { started } }

    /// Current device snapshot. Call `start()` first (the N-API layer does).
    func currentDevices() -> [SimDeviceInfo] {
        lock.lock(); defer { lock.unlock() }
        return snapshot
    }

    /// Register a change observer; returns a token for `removeObserver`. The
    /// callback fires on the monitor's internal queue when the set changes.
    func addObserver(_ callback: @escaping () -> Void) -> Int {
        lock.lock(); defer { lock.unlock() }
        let id = nextObserverID
        nextObserverID += 1
        observers[id] = callback
        return id
    }

    func removeObserver(_ token: Int) {
        lock.lock(); defer { lock.unlock() }
        observers.removeValue(forKey: token)
    }
}
