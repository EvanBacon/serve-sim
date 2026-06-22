// swift-tools-version:6.0
//
// Builds serve-sim-native — the in-process N-API addon that replaces the
// spawned serve-sim-bin helper. The JS bindings are written directly in Swift
// with node-swift (NodeAPI), so there is no Objective-C++ glue: SimHID /
// SimCapture are NodeClasses and the accessibility dumps are async NodeFunctions
// (see Sources/SimNative/sim-module.swift). The reverse-engineered streaming
// logic in SimStreamHelper is reused verbatim.
//
// The actual .node is produced by Sources/SimNative/build.sh, which drives
// `swift build --arch arm64 --arch x86_64` for a universal binary and links
// napi_* with `-undefined dynamic_lookup` (resolved against the host Node/Bun
// at dlopen). `node-swift rebuild` is intentionally not used: it builds a single
// arch only, and cross-compiling per-arch with `--triple` breaks the
// `#NodeModule` macro.

import PackageDescription

let package = Package(
    name: "serve-sim-native",
    platforms: [.macOS(.v14)],
    products: [
        .library(
            name: "serve-sim-native",
            type: .dynamic,
            targets: ["SimNative"]
        ),
    ],
    dependencies: [
        .package(path: "node_modules/node-swift"),
    ],
    targets: [
        .target(
            name: "SimNative",
            dependencies: [
                .product(name: "NodeAPI", package: "node-swift"),
                .product(name: "NodeModuleSupport", package: "node-swift"),
            ],
            exclude: [
                "build.sh",
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-undefined",
                    "-Xlinker", "dynamic_lookup",
                ])
            ]
        ),
    ],
    // The reused SimStreamHelper logic was written against the standalone helper
    // (plain swiftc, which defaults to Swift 5 mode). Build in Swift 5 mode so its
    // benign cross-queue captures stay warnings rather than Swift 6 errors;
    // node-swift's API works in v5. Declared at package level so the target's
    // language mode is valid under stricter toolchains — CI rejects a target
    // language mode that isn't among the package's declared modes.
    swiftLanguageModes: [.v5]
)
