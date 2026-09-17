import Foundation

/// 命令行开关。除了给自动化脚本用，也方便用户在端口冲突时手动指定。
enum LaunchOptions {

    static var arguments: [String] { CommandLine.arguments }

    /// `--port N`。0 表示随机端口（默认）。
    static var port: UInt16 {
        let index = arguments.firstIndex(of: "--port")
        guard let index, index + 1 < arguments.count, let value = UInt16(arguments[index + 1]) else { return 0 }
        return value
    }

    static var debug: Bool { ProcessInfo.processInfo.environment["LT_MAC_DEBUG"] != nil }
}

/// 调试输出。只有 `LT_MAC_DEBUG=1` 时才写 stderr，平时完全静默。
///
/// `NSLog` 在这儿不好用：它无条件往统一日志里灌，跟随光标那种每秒好几次的
/// 调用会刷屏。用 stderr 是因为从终端直接跑二进制时正好能看见。
func ltTrace(_ message: @autoclosure () -> String) {
    guard LaunchOptions.debug else { return }
    FileHandle.standardError.write(Data(("lt: " + message() + "\n").utf8))
}

/// 应用用到的几个路径。开发态（swift run）和打包态（.app）都要能找到引擎资源，
/// 所以这里不写死，按优先级探测。
enum Paths {

    /// 引擎页面所在目录。打包后在 Contents/Resources/web，
    /// 开发态在 macos/dist/web（构建脚本生成）。
    static var webRoot: URL {
        if let override = ProcessInfo.processInfo.environment["LT_WEB_ROOT"] {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
           FileManager.default.fileExists(atPath: bundled.appendingPathComponent("engine.html").path) {
            return bundled
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            .appendingPathComponent("dist/web", isDirectory: true)
    }

    /// 语言包缓存。放在 Application Support 下，用户想手动清就直接删这个目录。
    static var supportDirectory: URL {
        if let override = ProcessInfo.processInfo.environment["LT_SUPPORT_DIR"] {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("TranslateAssistant", isDirectory: true)
    }

    static var cacheRoot: URL { supportDirectory.appendingPathComponent("packs", isDirectory: true) }

    static var engineInstalled: Bool {
        FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("engine.html").path)
    }
}
