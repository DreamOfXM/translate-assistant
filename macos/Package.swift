// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TranslateAssistant",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "TranslateAssistant",
            path: "Sources/TranslateAssistant",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
