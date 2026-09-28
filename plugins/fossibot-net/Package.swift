// swift-tools-version: 5.9
import PackageDescription

// Name must equal the Capacitor CLI's fixName("fossibot-net") so CapApp-SPM can reference it.
let package = Package(
    name: "FossibotNet",
    platforms: [.iOS(.v15)],
    products: [.library(name: "FossibotNet", targets: ["FossibotNetPlugin"])],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "FossibotNetPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/FossibotNetPlugin")
    ]
)
