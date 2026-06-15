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
            linkerSettings: [
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("IOSurface"),
            ]
        ),
    ]
)
