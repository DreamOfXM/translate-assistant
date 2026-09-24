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
    private var hotKeyError: String?
    private var current: Accessibility.FieldSnapshot?
    /// 本次翻译的选区（「翻译选中文字」走这条路，跟输入框那条完全分开）
    private var currentSelection: Selection.Capture?
    private var currentMode: Mode = .wholeField
    private var trustTimer: Timer?

    /// 输入框旁边那个常驻小按钮，以及决定它在哪出现的跟随器
    private let pill = InlinePill()
    private let focusTracker = FocusTracker()
    /// 浮标当前盯着的输入框，点下去时按它取内容（而不是再问一次系统焦点）
    private var pillTarget: Accessibility.FieldGeometry?
    /// 「在 App 里翻译浏览器当前页面」的窗口：不经过扩展，也不需要辅助功能授权
    private var pageWindow: PageWindowController!

    // MARK: - 启动

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "译"
        statusItem.button?.toolTip = "翻译助手"

        applyActivationPolicy()

        hud.bind(
            onFill: { [weak self] in self?.fillBack() },
            onCopy: { [weak self] in self?.copyTranslation() },
            onRetry: { [weak self] in self?.retry() },
            onClose: { [weak self] in self?.hud.close() }
        )

        pageWindow = PageWindowController(engine: engine)

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
        refreshMenuLater()
        startTrustWatch()
        startInlinePill()

        // 没有窗口的程序，启动完屏幕上什么都不会多出来 —— 第一件事就是说明自己是谁、
        // 入口在哪。未授权时那个弹窗里直接给「去授权」，不再另外弹系统对话框，
        // 否则两个框前后脚出现只会让人更懵。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.showWelcomeIfNeeded(triggeredByUser: false)
        }
    }

    /// 已经在跑的时候再双击一次 App，系统只会把它激活、不会再开一个实例。
    /// 没有窗口就没有任何可见反馈，看起来就是「双击没反应」——这里补上一次说明。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWelcomeIfNeeded(triggeredByUser: true)
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        trustTimer?.invalidate()
        focusTracker.stop()
        pill.hide()
        pageWindow?.shutdown()
        engine.shutdown()
        server.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: - 让用户找得到这个 App

    /// 菜单栏程序默认不占程序坞。但菜单栏挤的时候系统会把状态项直接挤掉，
    /// 那时屏幕上根本没有「译」，程序坞图标就是唯一可靠的入口 —— 交给用户选。
    private func applyActivationPolicy() {
        NSApp.setActivationPolicy(preferences.showsInDock ? .regular : .accessory)
    }

    @objc private func menuToggleDock() {
        preferences.showsInDock.toggle()
        applyActivationPolicy()
        rebuildMenu()
        if preferences.showsInDock {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func showWelcomeIfNeeded(triggeredByUser: Bool) {
        // 手动再点一次 App 一定要有反馈，所以那条「启动不再提示」管不到它
        if !triggeredByUser && preferences.hidesWelcome { return }

        var lines = ["它没有窗口。入口在屏幕最顶部菜单栏最右边的「译」字，程序坞里也有一个图标。", ""]
        lines.append("· 光标进输入框时，它的右上角会浮出一个「译」按钮，点一下即可——不用记热键")
        lines.append("· \(preferences.wholeFieldHotKey.description)：翻译光标所在的输入框")
        lines.append("· \(preferences.selectionHotKey.description)：翻译选中的文字")
        lines.append("· 菜单里的「在 App 里翻译浏览器当前页面」：不装扩展，在 App 的窗口里做整页双语")
        if !Accessibility.isTrusted {
            lines.append("")
            lines.append("还没授权：点「去授权」，在「辅助功能」里勾上本 App。没授权的话热键读不到别的 App 的输入框。")
        }
        lines.append("")
        lines.append("菜单栏挤的时候「译」会被系统整个挤掉，所以程序坞里那个图标是有意留的 —— 双击它就会回到这个提示。")

        let alert = NSAlert()
        alert.messageText = "翻译助手正在运行"
        alert.informativeText = lines.joined(separator: "\n")
        alert.alertStyle = .informational
        alert.addButton(withTitle: "知道了")
        if !Accessibility.isTrusted {
            alert.addButton(withTitle: "去授权")
        }
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "启动时不再提示"

        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()

        if !Accessibility.isTrusted && response == .alertSecondButtonReturn {
            Accessibility.requestTrust(prompt: true)
        }
        if alert.suppressionButton?.state == .on {
            preferences.hidesWelcome = true
        }
    }

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
        hotKeyError = nil

        let whole = HotKeyCenter.shared.register(preferences.wholeFieldHotKey) { [weak self] in
            Task { @MainActor in self?.begin(mode: .wholeField) }
        }
        let selection = HotKeyCenter.shared.register(preferences.selectionHotKey) { [weak self] in
            Task { @MainActor in self?.begin(mode: .selection) }
        }

        // 注册失败（被别的软件占用之类）必须让用户看得见，否则表现为「按了没反应」
        if !whole && !selection {
            hotKeyError = "两个热键都没注册成功，可能被其它软件占用了"
        } else if !whole {
            hotKeyError = "\(preferences.wholeFieldHotKey.description) 没注册成功，可能被别的软件占用"
        } else if !selection {
            hotKeyError = "\(preferences.selectionHotKey.description) 没注册成功，可能被别的软件占用"
        }
    }

    // MARK: - 主流程

    /// 本次翻译对应输入框的位置，供「重新翻译」沿用同样的摆放
    private var currentAnchor: CGRect?

    private func begin(mode: Mode, anchor: Accessibility.FieldGeometry? = nil) {
        guard ensureTrusted() else { return }

        if let engineError {
            hud.notice("引擎不可用：\(engineError)")
            return
        }

        switch mode {
        case .selection:
            beginSelection()
        case .wholeField:
            beginWholeField(anchor: anchor)
        }
    }

    /// 「翻译选中文字」。
    ///
    /// 跟输入框那条路完全分开：选区可能压根不在任何输入框里（邮件阅读窗格、
    /// 网页正文都是只读的），所以不能要求「先有一个焦点输入框」。取选区本身
    /// 分三条通道，细节见 `Selection`。
    private func beginSelection(fallbackFromField: Bool = false) {
        let result = Selection.read()
        guard let capture = result.capture else {
            hud.notice(result.error ?? hintToWholeField)
            return
        }

        let text = capture.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            hud.notice("没有选中任何文字。" + (fallbackFromField ? "" : "　" + hintToWholeField))
            return
        }
        guard text.count <= preferences.maxCharacters else {
            hud.notice("选中的文字有 \(text.count) 个字符，超过上限 \(preferences.maxCharacters)。先在设置里放宽，或少选一段再翻。")
            return
        }

        current = nil
        currentSelection = capture
        currentMode = .selection
        currentAnchor = capture.anchor

        let appName = capture.appName ?? "未知应用"
        // 只读的地方（邮件阅读窗格、网页正文）「填入」是写不进去的。与其让用户点了
        // 才吃一个红字报错，不如一开始就把这件事写在状态行里，并把按钮收起来。
        let readOnly = capture.readOnlyTarget
        var status = "\(appName) · \(capture.source.rawValue)"
        if fallbackFromField { status += " · 输入框是空的，改翻选中的" }
        if readOnly { status += " · 只读，译文可直接复制" }
        hud.show(
            original: text,
            status: status + " · 翻译中…",
            near: currentAnchor,
            canFill: !readOnly
        )
        Task { await translate(text) }
    }

    /// 「翻译当前输入框」。
    private func beginWholeField(anchor: Accessibility.FieldGeometry?) {
        // 从浮标点进来时翻的就是浮标旁边那个输入框。这里不再问一次系统焦点 ——
        // 用户的手可能已经点到别处，再问就该翻错对象了。
        let snapshot = anchor.map { Accessibility.snapshot(of: $0) } ?? Accessibility.snapshot()
        guard let snapshot else {
            // 读不到输入框时也别一口回绝：用户十有八九是选中了东西才按的键
            fallbackToSelection(reason: nil)
            return
        }

        let text = snapshot.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            // 空输入框没什么可翻，但用户很可能刚选中了一段文字。
            // 改翻选区，并且**把模式一起换成选区** ——
            // 否则「填入」还是会去整框覆写，那是会毁草稿的。
            fallbackToSelection(reason: "这个输入框是空的，改翻你选中的文字。")
            return
        }
        guard text.count <= preferences.maxCharacters else {
            hud.notice("输入框有 \(text.count) 个字符，超过上限 \(preferences.maxCharacters)。先在设置里放宽，或只选一段再翻。")
            return
        }

        current = snapshot
        currentSelection = nil
        currentMode = .wholeField
        currentAnchor = anchor?.frame

        let appName = snapshot.appName ?? "未知应用"
        let channel = snapshot.writableChannel ?? "只读"
        hud.show(original: text, status: "\(appName) · \(channel) · 翻译中…", near: currentAnchor)

        Task { await translate(text) }
    }

    /// 输入框这条路走不通时的去处：改翻选中的文字。
    ///
    /// 只在「输入框是空的」或「读不到输入框」时用 —— 这两种情况本来就没有可翻的内容，
    /// 所以不存在「本来想翻整框、结果翻了别的」的风险。真的没有选区时，
    /// 提示会直接告诉用户该按哪个键。
    private func fallbackToSelection(reason: String?) {
        if let reason { ltTrace("wholeField 落空：\(reason)") }
        beginSelection(fallbackFromField: true)
    }

    /// 把「另一个热键是哪个」说清楚。
    ///
    /// 两个热键挨着（⌃⌥T / ⌃⌥Y），按错是常事；而原来的提示只说「没有选中任何文字」，
    /// 用户没法从里面知道该按哪个键。
    private var hintToWholeField: String {
        "想翻整个输入框，按 \(preferences.wholeFieldHotKey.description)。"
    }

    private func translate(_ text: String) async {
        do {
            let result = try await engine.translate(
                text: text,
                from: preferences.direction.from,
                to: preferences.direction.to
            )
            hud.update(
                translated: result.text,
                status: "\(targetAppName) · \(result.source.uppercased()) → \(result.target.uppercased())",
                warning: quotedHistoryWarning(in: text)
            )
        } catch {
            hud.fail("翻译失败：\(error.localizedDescription)")
        }
    }

    /// 本次翻译对应的 App 名，两种模式都得能取到
    private var targetAppName: String {
        current?.appName ?? currentSelection?.appName ?? "未知应用"
    }

    /// 邮件、论坛的回复草稿里常带一长段引用历史。整框译完再「填入」会把引用一起换掉，
    /// 而用户多半只想译自己写的那几句 —— 所以先提醒，不拦着。
    private func quotedHistoryWarning(in text: String) -> String {
        let lowered = text.lowercased()
        let quotedLines = text.split(separator: "\n").filter {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix(">")
        }.count

        let hasBanner = lowered.contains("---- replied message ----")
            || lowered.contains("原始邮件")
            || lowered.contains("wrote:")
            || ((lowered.contains("写道:") || lowered.contains("写道：")))

        guard hasBanner || quotedLines >= 3 else { return "" }

        var parts = ["这段草稿里有引用历史"]
        if hasBanner { parts.append("含引用分隔标记") }
        if quotedLines > 0 { parts.append("> 引用行 \(quotedLines) 行") }

        return "⚠︎ \(parts.joined(separator: "，"))。点「填入」是整框替换，会把引用一起换掉；"
            + "只想译自己写的那几句，先选中它们再按 \(preferences.selectionHotKey.description)。"
    }

    private func retry() {
        switch currentMode {
        case .selection:
            guard let capture = currentSelection else { return }
            hud.show(
                original: capture.text,
                status: "重新翻译…",
                near: capture.anchor,
                canFill: capture.canFillInPlace
            )
            Task { await translate(capture.text) }
        case .wholeField:
            guard let snapshot = current else { return }
            hud.show(original: snapshot.text, status: "重新翻译…", near: currentAnchor)
            Task { await translate(snapshot.text) }
        }
    }

    /// 把译文写回去。
    ///
    /// 两种模式的落点完全不同：输入框是「整框覆写或替换选区」，选区的落点则可能
    /// 压根不在 AX 能写的控件上（网页内容），那时只能借粘贴。所以交给各自的实现。
    private func fillBack() {
        let text = hud.translatedText
        guard !text.isEmpty else { return }

        switch currentMode {
        case .selection:
            guard let capture = currentSelection else { return }
            hud.setStatus("填入中…")
            // 结果浮层是能成为 key 的面板，得先把前台让回去，粘贴才有落脚点
            activateAndWait(capture.pid)
            finishFill(Selection.replace(text, in: capture))
        case .wholeField:
            guard let snapshot = current else { return }
            hud.setStatus("填入中…")
            activateAndWait(snapshot.pid)
            finishFill(Accessibility.write(text, into: snapshot))
        }
    }

    private func finishFill(_ result: Accessibility.WriteResult) {
        if result.ok {
            hud.close()
        } else {
            hud.fail("回填失败：\(result.error ?? "未知原因")")
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

    private func ensureTrusted() -> Bool {
        guard !Accessibility.isTrusted else { return true }
        Accessibility.requestTrust(prompt: true)
        hud.notice("需要「辅助功能」授权才能读写别的 App 的输入框。已在系统设置里打开对应面板，勾选本 App 后重启一次。")
        rebuildMenu()
        return false
    }

    // MARK: - 输入框旁的常驻浮标

    /// 打开「光标一进输入框，旁边就出现一个小『译』按钮」这条路。
    ///
    /// 重复调用是安全的：菜单里开关时会再走一次，所以要先把上一轮停干净。
    private func startInlinePill() {
        focusTracker.stop()
        focusTracker.onChange = { [weak self] geometry in
            self?.syncPill(with: geometry)
        }
        pill.onClick = { [weak self] in self?.pillClicked() }
        ltTrace("startInlinePill：开关=\(preferences.inlinePill)")
        guard preferences.inlinePill else { return }
        focusTracker.start()
    }

    /// 跟随器报了变化：有输入框就把按钮挪过去，没有（或用户关了这功能）就收起来。
    private func syncPill(with geometry: Accessibility.FieldGeometry?) {
        ltTrace("syncPill：geometry=\(geometry == nil ? "nil" : "\(geometry!.frame)")")
        guard preferences.inlinePill, let geometry else {
            pillTarget = nil
            focusTracker.quickPoll = false
            pill.hide()
            return
        }

        pillTarget = geometry
        focusTracker.quickPoll = true
        if pill.isVisible {
            pill.move(to: geometry.frame)
        } else {
            pill.show(at: geometry.frame)
        }
        ltTrace("syncPill：show/move 之后 isVisible=\(pill.isVisible)")
    }

    /// 点了浮标：翻它旁边那个输入框。按钮故意留着不藏 —— 结果浮层关掉后还能再点一次。
    private func pillClicked() {
        // 这条路是唯一会主动读用户草稿的入口，值班时留个痕，出了怪事能对上时间线
        ltTrace("pillClicked：target=\(pillTarget == nil ? "nil" : "\(pillTarget!.frame)")")
        guard let target = pillTarget else { return }
        begin(mode: .wholeField, anchor: target)
    }

    @objc private func menuTogglePill() {
        preferences.inlinePill.toggle()
        rebuildMenu()
        startInlinePill()
    }

    // MARK: - 菜单

    private func refreshMenuLater() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.rebuildMenu()
        }
    }

    /// 授权是用户去系统设置里手动勾的，勾完之后这个进程未必立刻生效。
    /// 盯着状态变化，一旦变已授权就刷新菜单并提示，省掉「为什么还是没反应」。
    private func startTrustWatch() {
        guard !Accessibility.isTrusted else { return }
        trustTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] timer in
            Task { @MainActor in
                guard let self, Accessibility.isTrusted else { return }
                timer.invalidate()
                self.trustTimer = nil
                self.rebuildMenu()
                // 授权之前 startInlinePill 里的 start() 会直接返回，这里补启动一次
                self.startInlinePill()
                self.hud.notice("辅助功能授权已生效。点进任意输入框，按 \(self.preferences.wholeFieldHotKey.description) 试试，或直接点输入框右上角的「译」按钮。")
            }
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

        // 只读浏览器标签页的地址，正文由 App 自己的窗口重新加载 ——
        // 这条路要的是「自动化」授权，不是「辅助功能」，所以没授权上面两项时它照样能点。
        let page = NSMenuItem(
            title: "在 App 里翻译浏览器当前页面",
            action: #selector(menuTranslatePage),
            keyEquivalent: ""
        )
        page.target = self
        menu.addItem(page)

        menu.addItem(.separator())

        let trust = NSMenuItem(
            title: Accessibility.isTrusted ? "辅助功能：已授权" : "辅助功能：未授权 —— 点击去授权",
            action: Accessibility.isTrusted ? nil : #selector(menuOpenTrust),
            keyEquivalent: ""
        )
        trust.target = self
        trust.isEnabled = !Accessibility.isTrusted
        menu.addItem(trust)

        // 授权刚勾上时进程内不一定立刻生效，给一个一键重启，省得用户自己去找
        if !Accessibility.isTrusted {
            let restart = NSMenuItem(title: "重启应用（授权后如仍无反应就用这个）", action: #selector(menuRestart), keyEquivalent: "")
            restart.target = self
            menu.addItem(restart)
        }

        let dock = NSMenuItem(
            title: preferences.showsInDock ? "从程序坞隐藏" : "在程序坞显示图标",
            action: #selector(menuToggleDock),
            keyEquivalent: ""
        )
        dock.target = self
        menu.addItem(dock)

        // 开关状态要连「为什么它没出现」一起说：没授权时它就是个看不见的按钮，
        // 用户只会以为功能坏了，而不会想到去上面那行点授权。
        let pillTitle: String
        if !preferences.inlinePill {
            pillTitle = "输入框旁显示「译」按钮：关"
        } else if Accessibility.isTrusted {
            pillTitle = "输入框旁显示「译」按钮：开"
        } else {
            pillTitle = "输入框旁显示「译」按钮：开（还没授权，暂时不会出现）"
        }
        let pillItem = NSMenuItem(
            title: pillTitle,
            action: #selector(menuTogglePill),
            keyEquivalent: ""
        )
        pillItem.target = self
        pillItem.isEnabled = Accessibility.isTrusted
        menu.addItem(pillItem)

        let engineItem = NSMenuItem(
            title: engineError.map { "引擎：不可用 · \($0)" } ?? "引擎：本地离线（Bergamot）",
            action: nil,
            keyEquivalent: ""
        )
        engineItem.isEnabled = false
        menu.addItem(engineItem)

        if let hotKeyError {
            let item = NSMenuItem(title: "热键：\(hotKeyError)", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

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
        statusItem.button?.toolTip = Accessibility.isTrusted
            ? "翻译助手"
            : "翻译助手 · 还没拿到「辅助功能」授权，热键和输入框旁的「译」按钮都不会工作"
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

    /// 「在 App 里翻译浏览器当前页面」：向浏览器要地址，正文在自己的窗口里翻。
    @objc private func menuTranslatePage() {
        let outcome = BrowserTabReader.readActiveTab()
        switch outcome {
        case .success(let page):
            ltTrace("menuTranslatePage：读到 \(page.browserName) · \(page.url.absoluteString)")
            pageWindow.present(page)
        case .failure(let error):
            ltTrace("menuTranslatePage：读取失败 \(error.localizedDescription)")
            pageWindow.presentError(error)
        }
    }

    @objc private func menuOpenTrust() {
        Accessibility.openSystemSettings()
    }

    /// 重启自己。先让系统把新实例拉起来，再退出当前这个 —— 反过来的话
    /// open 可能因为进程已经在退出而失败，用户就白白关掉了一个还在跑的 App。
    @objc private func menuRestart() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-n", Bundle.main.bundlePath]
        do {
            try task.run()
        } catch {
            hud.notice("重启失败：\(error.localizedDescription)。手动退出再打开一次即可。")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { NSApp.terminate(nil) }
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
