// swift-tools-version: 5.9
import PackageDescription
import Foundation

let developerDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
    ?? "/Applications/Xcode.app/Contents/Developer"
let privateFrameworks = "\(developerDir)/Library/PrivateFrameworks"

let package = Package(
    name: "SimStreamHelper",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/httpswift/swifter.git", from: "1.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "serve-sim-bin",
            dependencies: [
                .product(name: "Swifter", package: "swifter"),
            ],
            path: "Sources/SimStreamHelper",
            swiftSettings: [
                .unsafeFlags([
                    "-F/Library/Developer/PrivateFrameworks",
                    "-F\(privateFrameworks)",
                ]),
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F/Library/Developer/PrivateFrameworks",
                    "-F\(privateFrameworks)",
                    "-Xlinker", "-rpath", "-Xlinker", "/Library/Developer/PrivateFrameworks",
                    "-Xlinker", "-rpath", "-Xlinker", "\(privateFrameworks)",
                ]),
                .linkedFramework("CoreSimulator"),
                .linkedFramework("SimulatorKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("IOSurface"),
            ]
        ),
    ]
)
