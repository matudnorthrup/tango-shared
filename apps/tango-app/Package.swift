// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Tango",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "Tango", targets: ["TangoApp"])],
    dependencies: [.package(path: "../tango-ios/TangoDeskKit")],
    targets: [
        .target(name: "TangoKit"),
        .target(name: "TangoVoice", dependencies: [.product(name: "TangoDeskKit", package: "TangoDeskKit")]),
        .executableTarget(name: "TangoApp", dependencies: ["TangoKit", "TangoVoice"]),
        .testTarget(name: "TangoKitTests", dependencies: ["TangoKit"]),
        .testTarget(name: "TangoVoiceTests", dependencies: ["TangoVoice"], exclude: ["voice-fixture.cjs"]),
    ]
)
