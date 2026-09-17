import AppKit
import Foundation

/**
 入口。

 用 `@main` 而不是 main.swift 的顶层代码：顶层代码是非隔离上下文，
 在里面构造 `@MainActor` 的 AppDelegate 会直接编译失败；而 main.swift 不能
 和 `@main` 共存，所以入口放在这个文件里。
 */
@main
enum Entry {

    @MainActor
    static func main() async {
        let arguments = CommandLine.arguments

        // 只起引擎服务：给自动化脚本验证引擎页面用，不需要授权也不需要界面
        if arguments.contains("--serve") { exit(serveMode()) }
        // 连 WKWebView 一起验证：起服务 → 加载引擎页 → 真翻一句 → 退出
        if arguments.contains("--check-engine") { exit(await engineCheckMode()) }
        if arguments.contains("--self-check") { exit(selfCheckMode()) }

        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        // 菜单栏应用：不占 Dock，不抢焦点
        application.setActivationPolicy(.accessory)
        application.run()
    }

    private static func serveMode() -> Int32 {
        let server = EngineServer(webRoot: Paths.webRoot, cacheRoot: Paths.cacheRoot)
        do {
            try server.start(preferredPort: LaunchOptions.port)
        } catch {
            FileHandle.standardError.write(Data("引擎服务启动失败：\(error.localizedDescription)\n".utf8))
            return 1
        }
        print("ready \(server.baseURL.absoluteString)")
        print("webRoot \(Paths.webRoot.path)")
        print("cacheRoot \(Paths.cacheRoot.path)")
        fflush(stdout)
        CFRunLoopRun()
        return 0
    }

    /// 在真实 App 进程里验证「回环服务 + WKWebView + Bergamot WASM」这条链。
    /// 它不碰辅助功能，所以能在没授权的情况下跑通，是最有价值的自动验证点。
    @MainActor
    private static func engineCheckMode() async -> Int32 {
        // WKWebView 需要 NSApplication 存在才能工作
        _ = NSApplication.shared

        let server = EngineServer(webRoot: Paths.webRoot, cacheRoot: Paths.cacheRoot)
        do {
            try server.start(preferredPort: LaunchOptions.port)
        } catch {
            print("引擎服务启动失败：\(error.localizedDescription)")
            return 1
        }
        print("引擎服务 \(server.baseURL.absoluteString)")
        print("引擎资源 \(Paths.webRoot.path)")

        let bridge = EngineBridge()
        bridge.onProgress = { progress in
            guard progress.percent % 20 == 0, !progress.label.isEmpty else { return }
            print("  进度 \(progress.percent)% \(progress.label)")
        }
        bridge.start(baseURL: server.baseURL)

        do {
            let catalog = try await bridge.catalog()
            print("语言包目录：\(catalog.count) 个方向")
            print("含 en-zh：\(catalog.contains { ($0["key"] as? String) == "en-zh" })")

            let detected = try await bridge.detect("Hello there, this is a test.")
            print("detect(英文) = \(detected)")

            let started = Date()
            let result = try await bridge.translate(text: "Hello, how are you today? I hope everything is fine.", from: "en", to: "zh")
            print(String(format: "en→zh %.1fs", Date().timeIntervalSince(started)))
            print("  译文 = \(result.text)")

            let back = try await bridge.translate(text: "这个功能挺好用的，我每天都在用。", from: "zh", to: "en")
            print("  回译 = \(back.text)")
        } catch {
            print("失败：\(error.localizedDescription)")
            bridge.shutdown()
            server.stop()
            return 1
        }

        bridge.shutdown()
        server.stop()
        print("引擎链验证通过")
        return 0
    }

    private static func selfCheckMode() -> Int32 {
        var lines = Accessibility.diagnostics()
        lines.append("")
        lines.append("引擎资源：\(Paths.webRoot.path)（\(Paths.engineInstalled ? "存在" : "缺失")）")
        lines.append("语言包目录：\(Paths.cacheRoot.path)")

        let packs = (try? FileManager.default.contentsOfDirectory(atPath: Paths.cacheRoot.path)) ?? []
        lines.append("已缓存语言包：\(packs.isEmpty ? "无" : packs.joined(separator: "、"))")

        print(lines.joined(separator: "\n"))
        return 0
    }
}
