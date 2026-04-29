// swift-tools-version: 5.9
import PackageDescription

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
                    "-F/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks",
                ]),
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F/Library/Developer/PrivateFrameworks",
                    "-F/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks",
                    "-Xlinker", "-rpath", "-Xlinker", "/Library/Developer/PrivateFrameworks",
                    "-Xlinker", "-rpath", "-Xlinker", "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks",
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
