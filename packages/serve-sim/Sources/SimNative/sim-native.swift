import Foundation

// MVP surface for the in-process native addon. These `@_cdecl` shims are the
// C ABI boundary the Objective-C++ N-API layer (sim-native.mm) calls into.
// Real SimStreamHelper logic (frame capture, encoders, HID) will land here as
// additional shims once the build/deploy pipeline is proven.

/// Returns a heap-allocated C string the caller must free(). Proves Swift code
/// linked into the .node can call into a real Apple framework (Foundation).
@_cdecl("sim_native_version")
public func sim_native_version() -> UnsafeMutablePointer<CChar> {
    let os = ProcessInfo.processInfo.operatingSystemVersion
    let info = "serve-sim-native swift=\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
    return strdup(info)!
}

/// Trivial compute to confirm arguments cross the JS↔Swift boundary intact.
@_cdecl("sim_native_add")
public func sim_native_add(_ a: Int32, _ b: Int32) -> Int32 {
    return a + b
}
