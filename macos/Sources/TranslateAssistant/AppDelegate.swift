import AppKit
import Foundation

/**
 应用主流程：热键 → 读输入框 → 翻译 → 浮层 → 回填。

 三条路径都建立在同一个前提上：输入框来自别的进程，靠 AX 读写。
 网页和原生 App 走的是同一条路 —— AX 看到的是「当前焦点控件」，
 不关心它背后是 Safari、微信还是备忘录。
 */
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    enum Mode {
        case wholeField
        case selection
    }

    private var statusItem: NSStatusItem!
    private let engine = EngineBridge()
    private let server = EngineServer(webRoot: Paths.webRoot, cacheRoot: Paths.cacheRoot)
    private let hud = HUDController()
    private let preferences = Preferences.shared

    private var engineError: String?
    private var current: Accessibility.FieldSnapshot?
    private var currentMode: Mode = .wholeField

    // MARK: - 启动

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "译"
        statusItem.button?.toolTip = "翻译助手"

        hud.bind(
            onFill: { [weak self] in self?.fillBack() },
            onCopy: { [weak self] in self?.copyTranslation() },
            onRetry: { [weak self] in self?.retry() },
            onClose: { [weak self] in self?.hud.close() }
        )

        engine.onProgress = { [weak self] progress in
            guard let self else { return }
            if self.hud.isVisible {
                self.hud.setStatus(progress.label)
            } else {
                self.statusItem.button?.toolTip = "翻译助手 · \(progress.label)"
            }
        }

        startEngine()
        registerHotKeys()
        rebuildMenu()

        // 第一次运行时把授权对话框弹出来，否则用户只会看到「按了没反应」
        if !Accessibility.isTrusted && !preferences.didPromptForTrust {
            preferences.didPromptForTrust = true
            Accessibility.requestTrust(prompt: true)
        }
        refreshMenuLater()
    }

    func applicationWillTerminate(_ notification: Notification) {
        engine.shutdown()
        server.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func startEngine() {
        guard Paths.engineInstalled else {
            engineError = "找不到引擎资源（\(Paths.webRoot.path)），先跑 npm run build:macos"
            return
        }
        do {
            try server.start(preferredPort: LaunchOptions.port)
        } catch {
            engineError = error.localizedDescription
            return
        }
        engine.start(baseURL: server.baseURL)
    }

    private func registerHotKeys() {
        HotKeyCenter.shared.unregisterAll()
        HotKeyCenter.shared.register(preferences.wholeFieldHotKey) { [weak self] in
            Task { @MainActor in self?.begin(mode: .wholeField) }
        }
        HotKeyCenter.shared.register(preferences.selectionHotKey) { [weak self] in
            Task { @MainActor in self?.begin(mode: .selection) }
        }
    }

    // MARK: - 主流程

    private func begin(mode: Mode) {
        guard ensureTrusted() else { return }

        if let engineError {
            hud.notice("引擎不可用：\(engineError)")
            return
        }

        guard let snapshot = Accessibility.snapshot() else {
            hud.notice("没读到输入框。先把光标点进某个输入框，或改用「翻译选中文字」。")
            return
        }

        let raw = mode == .selection ? (snapshot.selectedText ?? "") : snapshot.text
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !text.isEmpty else {
            hud.notice(mode == .selection ? "没有选中任何文字。" : "这个输入框是空的。")
            return
        }

        guard text.count <= preferences.maxCharacters else {
            hud.notice("输入框有 \(text.count) 个字符，超过上限 \(preferences.maxCharacters)。先在设置里放宽，或只选一段再翻。")
            return
        }

        current = snapshot
        currentMode = mode

        let appName = snapshot.appName ?? "未知应用"
        let channel = snapshot.writableChannel ?? "只读"
        hud.show(original: text, status: "\(appName) · \(channel) · 翻译中…")

        Task { await translate(text) }
    }

    private func translate(_ text: String) async {
        do {
            let result = try await engine.translate(
                text: text,
                from: preferences.direction.from,
                to: preferences.direction.to
            )
            let appName = current?.appName ?? "未知应用"
            hud.update(
                translated: result.text,
                status: "\(appName) · \(result.source.uppercased()) → \(result.target.uppercased())"
            )
        } catch {
            hud.fail("翻译失败：\(error.localizedDescription)")
        }
    }

    private func retry() {
        guard let snapshot = current else { return }
        let text = currentMode == .selection ? (snapshot.selectedText ?? "") : snapshot.text
        hud.show(original: text, status: "重新翻译…")
        Task { await translate(text) }
    }

    private func fillBack() {
        guard let snapshot = current else { return }
        let text = hud.translatedText
        guard !text.isEmpty else { return }

        // 浮层是 key window，焦点可能已经不在原来的输入框上了，先把目标 App 拉回前台
        activate(snapshot.pid)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
            guard let self else { return }
            let channel: Accessibility.WriteChannel? = self.currentMode == .selection ? .selectedText : nil
            let result = Accessibility.write(text, into: snapshot, preferring: channel)
            if result.ok {
                self.hud.close()
            } else {
                self.hud.fail("回填失败：\(result.error ?? "未知原因")")
            }
        }
    }

    private func copyTranslation() {
        let text = hud.translatedText
        guard !text.isEmpty else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        hud.setStatus("已复制到剪贴板")
    }

    private func activate(_ pid: pid_t) {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return }
        if #available(macOS 14.0, *) {
            app.activate()
        } else {
            app.activate(options: [.activateAllWindows])
        }
    }

    private func ensureTrusted() -> Bool {
        guard !Accessibility.isTrusted else { return true }
        Accessibility.requestTrust(prompt: true)
        hud.notice("需要「辅助功能」授权才能读写别的 App 的输入框。已在系统设置里打开对应面板，勾选本 App 后重启一次。")
        rebuildMenu()
        return false
    }

    // MARK: - 菜单

    private func refreshMenuLater() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.rebuildMenu()
        }
    }

    func rebuildMenu() {
        let menu = NSMenu()

        let whole = NSMenuItem(
            title: "翻译当前输入框（\(preferences.wholeFieldHotKey.description)）",
            action: #selector(menuWholeField),
            keyEquivalent: ""
        )
        whole.target = self
        whole.isEnabled = Accessibility.isTrusted
        menu.addItem(whole)

        let selection = NSMenuItem(
            title: "翻译选中文字（\(preferences.selectionHotKey.description)）",
            action: #selector(menuSelection),
            keyEquivalent: ""
        )
        selection.target = self
        selection.isEnabled = Accessibility.isTrusted
        menu.addItem(selection)

        menu.addItem(.separator())

        let trust = NSMenuItem(
            title: Accessibility.isTrusted ? "辅助功能：已授权" : "辅助功能：未授权 —— 点击去授权",
            action: Accessibility.isTrusted ? nil : #selector(menuOpenTrust),
            keyEquivalent: ""
        )
        trust.target = self
        trust.isEnabled = !Accessibility.isTrusted
        menu.addItem(trust)

        let engineItem = NSMenuItem(
            title: engineError.map { "引擎：不可用 · \($0)" } ?? "引擎：本地离线（Bergamot）",
            action: nil,
            keyEquivalent: ""
        )
        engineItem.isEnabled = false
        menu.addItem(engineItem)

        menu.addItem(.separator())
        menu.addItem(directionMenu())
        menu.addItem(packsMenu())
        menu.addItem(.separator())

        let check = NSMenuItem(title: "自检（复制到剪贴板）", action: #selector(menuSelfCheck), keyEquivalent: "")
        check.target = self
        menu.addItem(check)

        let quit = NSMenuItem(title: "退出翻译助手", action: #selector(menuQuit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
        statusItem.button?.toolTip = "翻译助手"
    }

    private func directionMenu() -> NSMenuItem {
        let parent = NSMenuItem(title: "语言方向：\(preferences.direction.title)", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for mode in DirectionMode.allCases {
            let item = NSMenuItem(title: mode.title, action: #selector(menuDirection(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = mode.rawValue
            item.state = preferences.direction == mode ? .on : .off
            submenu.addItem(item)
        }
        parent.submenu = submenu
        return parent
    }

    private func packsMenu() -> NSMenuItem {
        let parent = NSMenuItem(title: "语言包", action: nil, keyEquivalent: "")
        let submenu = NSMenu()

        let preload = NSMenuItem(title: "预下载当前方向", action: #selector(menuPreload), keyEquivalent: "")
        preload.target = self
        submenu.addItem(preload)

        let open = NSMenuItem(title: "打开语言包目录", action: #selector(menuOpenPacks), keyEquivalent: "")
        open.target = self
        submenu.addItem(open)

        let clear = NSMenuItem(title: "清空语言包缓存", action: #selector(menuClearPacks), keyEquivalent: "")
        clear.target = self
        submenu.addItem(clear)

        parent.submenu = submenu
        return parent
    }

    // MARK: - 菜单动作

    @objc private func menuWholeField() { begin(mode: .wholeField) }
    @objc private func menuSelection() { begin(mode: .selection) }

    @objc private func menuOpenTrust() {
        Accessibility.openSystemSettings()
    }

    @objc private func menuDirection(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let mode = DirectionMode(rawValue: raw) else { return }
        preferences.direction = mode
        rebuildMenu()
    }

    @objc private func menuPreload() {
        guard engineError == nil else {
            hud.notice("引擎不可用：\(engineError ?? "")")
            return
        }
        let directions = preferences.direction.preloadDirections
        hud.notice("开始预下载：\(directions.joined(separator: "、"))")
        Task {
            for direction in directions {
                do {
                    try await engine.preload(direction: direction)
                } catch {
                    hud.fail("语言包下载失败（\(direction)）：\(error.localizedDescription)")
                    return
                }
            }
            hud.notice("语言包已就绪。以后翻译不再需要联网。")
        }
    }

    @objc private func menuOpenPacks() {
        try? FileManager.default.createDirectory(at: Paths.cacheRoot, withIntermediateDirectories: true)
        NSWorkspace.shared.open(Paths.cacheRoot)
    }

    @objc private func menuClearPacks() {
        try? FileManager.default.removeItem(at: Paths.cacheRoot)
        hud.notice("已清空语言包缓存，下次翻译会重新下载。")
    }

    @objc private func menuSelfCheck() {
        var lines = Accessibility.diagnostics()
        lines.append("")
        lines.append("引擎资源：\(Paths.webRoot.path)")
        lines.append("引擎服务：\(server.port == 0 ? "未启动" : "127.0.0.1:\(server.port)")")
        if let engineError { lines.append("引擎错误：\(engineError)") }
        lines.append("语言包目录：\(Paths.cacheRoot.path)")
        lines.append("语言方向：\(preferences.direction.title)")

        let report = lines.joined(separator: "\n")
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(report, forType: .string)

        FileHandle.standardError.write(Data((report + "\n").utf8))
        hud.notice("自检信息已复制到剪贴板，可直接粘贴反馈。")
    }

    @objc private func menuQuit() {
        NSApp.terminate(nil)
    }
}
