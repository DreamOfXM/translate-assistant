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
        // 排「翻译选中文字」的问题：把三条通道各自的结果打出来。加 --copy 就真跑一次
        if arguments.contains("--check-selection") {
            exit(selectionCheckMode(act: arguments.contains("--copy")))
        }

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

    /// 排「翻译选中文字」的问题用。
    ///
    /// 默认看「此刻的前台应用」—— 所以在终端里敲的话要加 `--selection-pid <pid>`，
    /// 否则前台就是终端自己。pid 用 `pgrep` 或者 `--check-selection` 的输出找。
    ///
    /// 加 `--copy` 就真跑一次读选区（会走菜单项/合成按键那两条通道，因此会短暂
    /// 借用剪贴板），用来验证兜底通道和剪贴板复原是否真的有效。
    private static func selectionCheckMode(act: Bool) -> Int32 {
        let target = LaunchOptions.selectionPid
        print(Selection.diagnostics(target: target).joined(separator: "\n"))
        guard act else { return 0 }

        print("")
        print("—— 真跑一次 read() ——")
        let pasteboard = NSPasteboard.general
        let before = pasteboard.string(forType: .string) ?? "（剪贴板里没有文本）"

        let result = Selection.read(target: target)
        if let capture = result.capture {
            print("读到：\(capture.source.rawValue)，\(capture.text.count) 字")
            print("内容：\(flatten(capture.text))")
        } else {
            print("没读到：\(result.error ?? "未知原因")")
        }

        let after = pasteboard.string(forType: .string) ?? "（剪贴板里没有文本）"
        print("剪贴板复原：\(before == after ? "是" : "否 —— \(flatten(before)) → \(flatten(after))")")

        // `--paste-check <文本>`：把这段文本真的回填进去，验证「替换」那条路。
        // 目标窗口标题会被打出来，方便对着一看有没有真的落进去。
        if let index = CommandLine.arguments.firstIndex(of: "--paste-check"),
           index + 1 < CommandLine.arguments.count {
            let probe = CommandLine.arguments[index + 1]
            guard let capture = result.capture else {
                print("没有读到选区，回填测试跳过")
                return 0
            }
            let outcome = Selection.replace(probe, in: capture)
            print("回填：\(outcome.ok ? "成功" : "失败")，通道 \(outcome.channel?.rawValue ?? "无")")
            if let error = outcome.error { print("说明：\(error)") }
            print("窗口标题：\(windowTitles(of: target ?? capture.pid))")
            let kept = NSPasteboard.general.string(forType: .string) ?? "（空）"
            print("剪贴板现在是：\(flatten(kept))")
        }
        return 0
    }

    private static func windowTitles(of pid: pid_t) -> [String] {
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, 0.5)
        return Accessibility.elements(appElement, kAXWindowsAttribute)
            .prefix(3)
            .compactMap { Accessibility.string($0, kAXTitleAttribute) }
    }

    private static func flatten(_ text: String) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: "⏎")
        return flat.count > 60 ? String(flat.prefix(60)) + "…" : flat
    }

    private static func selfCheckMode() -> Int32 {        var lines = Accessibility.diagnostics()
        lines.append("")
        lines.append("引擎资源：\(Paths.webRoot.path)（\(Paths.engineInstalled ? "存在" : "缺失")）")
        lines.append("语言包目录：\(Paths.cacheRoot.path)")

        let packs = (try? FileManager.default.contentsOfDirectory(atPath: Paths.cacheRoot.path)) ?? []
        lines.append("已缓存语言包：\(packs.isEmpty ? "无" : packs.joined(separator: "、"))")

        print(lines.joined(separator: "\n"))
        return 0
    }
}
