// Native framebuffer probe for bench-stream.ts — the "native Simulator"
// reference. Registers SimulatorKit screen callbacks (the same surface
// Simulator.app composites) and prints one line per framebuffer update:
//
//   F <epoch_ms> <width>x<height> <center BGRA hex>
//
// Build: swiftc -O -o /tmp/serve-sim-native-probe native-probe.swift
// Run:   /tmp/serve-sim-native-probe <udid>
import Foundation
import IOSurface

func load() {
    let pipe = Pipe(); let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select"); p.arguments = ["-p"]; p.standardOutput = pipe
    try? p.run(); p.waitUntilExit()
    let dev = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? "/Applications/Xcode.app/Contents/Developer"
    for path in [
        "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
        "\(dev)/../SharedFrameworks/SimulatorKit.framework/SimulatorKit",
        "\(dev)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
    ] { _ = dlopen(path, RTLD_NOW) }
    developerDir = dev
}
var developerDir = ""

@objc protocol FramebufferDescriptor {
    @objc(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)
    func registerScreenCallbacks(uuid: UUID, callbackQueue: DispatchQueue,
                                 frameCallback: @convention(block) @escaping () -> Void,
                                 surfacesChangedCallback: @convention(block) @escaping () -> Void,
                                 propertiesChangedCallback: @convention(block) @escaping () -> Void)
}

let udid = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
load()
guard let ctxClass = NSClassFromString("SimServiceContext") as? NSObject.Type,
      let ctx = ctxClass.perform(NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"), with: developerDir, with: nil)?.takeUnretainedValue() as? NSObject,
      let set = ctx.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?.takeUnretainedValue() as? NSObject,
      let devices = set.value(forKey: "devices") as? [NSObject],
      let device = devices.first(where: { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }),
      let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject
else { FileHandle.standardError.write("device not found\n".data(using: .utf8)!); exit(1) }

io.perform(NSSelectorFromString("updateIOPorts"))
let ports = io.value(forKey: "deviceIOPorts") as? [NSObject] ?? []
let surfSel = NSSelectorFromString("framebufferSurface")
var descs: [NSObject] = []
for port in ports {
    guard let pid = port.perform(NSSelectorFromString("portIdentifier"))?.takeUnretainedValue(),
          "\(pid)" == "com.apple.framebuffer.display",
          let d = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject,
          d.responds(to: surfSel) else { continue }
    descs.append(d)
}
let queue = DispatchQueue(label: "probe", qos: .userInteractive)
var lastSeed: [ObjectIdentifier: UInt32] = [:]
setvbuf(stdout, nil, _IOLBF, 0)

func check(_ d: NSObject) {
    guard let s = d.perform(surfSel)?.takeUnretainedValue() else { return }
    let surf = unsafeBitCast(s, to: IOSurface.self)
    let w = IOSurfaceGetWidth(surf), h = IOSurfaceGetHeight(surf)
    // Skip Device Hub presentation surfaces; the device screen is < 4K tall.
    guard w > 0, h > 0, h < 4000 else { return }
    let seed = IOSurfaceGetSeed(surf)
    if lastSeed[ObjectIdentifier(d)] == seed { return }
    lastSeed[ObjectIdentifier(d)] = seed
    let now = Date().timeIntervalSince1970 * 1000
    IOSurfaceLock(surf, .readOnly, nil)
    let base = IOSurfaceGetBaseAddress(surf)
    let bpr = IOSurfaceGetBytesPerRow(surf)
    let px = base.load(fromByteOffset: (h / 2) * bpr + (w / 2) * 4, as: UInt32.self)
    IOSurfaceUnlock(surf, .readOnly, nil)
    print(String(format: "F %.3f %dx%d %08x", now, w, h, px))
}
for d in descs {
    (d as AnyObject).registerScreenCallbacks(uuid: UUID(), callbackQueue: queue,
        frameCallback: { check(d) }, surfacesChangedCallback: { check(d) }, propertiesChangedCallback: {})
}
queue.async { for d in descs { check(d) } }
dispatchMain()
