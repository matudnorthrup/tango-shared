// swift-tools-version: 6.2
import PackageDescription
let package = Package(name: "TangoDeskKit", platforms: [.iOS(.v26), .macOS(.v15)], products: [
    .library(name: "TangoDeskKit", targets: ["TangoDeskKit"])
], targets: [.target(name: "TangoDeskKit"), .testTarget(name: "TangoDeskKitTests", dependencies: ["TangoDeskKit"])])
