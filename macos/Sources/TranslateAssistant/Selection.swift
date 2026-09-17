import AppKit
import ApplicationServices

/**
 读「用户此刻选中的那段文字」，以及把译文替换回去。

 为什么不能只靠 AX 属性 —— 2026-09-17 在 macOS 26 上实测：

 - 原生文本控件（文本编辑、备忘录）报得很稳：焦点控件上直接就有 `AXSelectedText`，
   内容一字不差。
 - Chromium 系（Chrome、基于 WebView 的邮件客户端、Electron 应用）只有把选区放进
   **可编辑**控件（命中 `AXTextArea`）时才一样稳；落在网页容器（`AXWebArea`）上就
   **时有时无**，报出来的时候还会把换行和制表符压平（选区里的 `下单⇥03` 变成 `下单03`）。
 - 只读页面（邮件阅读窗格、网页正文）经常什么都不报 —— 同一段选区、同一个页面，
   连跑两次能一次读到一次读不到，打开/关掉 Chromium 的辅助功能增强开关也不改变这一点。
 - 结论：网页里的选区和「输入框」不是一回事，不能只有一条路。

 于是分三条通道，按「副作用从小到大」依次退：

 1. `.accessibility` 问 AX 属性，且**只认真正的文本控件**。原生 App 走这条，
                    最快，绝不碰剪贴板。
 2. `.menu`          按目标 App「编辑」菜单里的「拷贝」项。纯 AX，不发合成按键；
                    而且菜单项的 enabled 恰好就是「此刻有没有选中东西」，
                    没选中时能立刻给准话，不用先污染剪贴板再说。
                    实测这条读出来的是**完整原文**（换行、制表符都在），
                    正好补上第 1 条压平空白的毛病。
 3. `.keystroke`     发一次合成 ⌘C。收尾兜底，并且避开终端类应用 ——
                    那些地方的 ⌘C 常被绑成「发送 ^C」，替用户按一下等于往他的
                    shell 里塞一个中断，这种事宁可失败也不能干。

 替换同理：能 AX 原地替换就 AX，否则按菜单「粘贴」项，最后才发合成 ⌘V。
 第 2、3 条会先把剪贴板存下来、用完复原。
 */
enum Selection {

    // MARK: - 结果

    enum Source: String {
        case accessibility = "AX 选区"
        case menu = "菜单拷贝"
        case keystroke = "模拟 ⌘C"
    }

    struct Capture {
        let text: String
        let source: Source
        let pid: pid_t
        let appName: String?
        /// AX 通道命中的那个承载选区的控件。有它才谈得上原地替换
        let element: AXUIElement?
        /// 浮层的锚点（AX 坐标）。只有 AX 通道知道选区在哪
        let anchor: CGRect?
    }

    struct ReadResult {
        let capture: Capture?
        /// 没读到时的原因，可直接显示给用户
        let error: String?

        static func ok(_ capture: Capture) -> ReadResult { ReadResult(capture: capture, error: nil) }
        static func no(_ reason: String) -> ReadResult { ReadResult(capture: nil, error: reason) }
    }

    // MARK: - 自检

    /// 给 `--check-selection` 用：三条通道各自试一遍，逐条报结果。
    ///
    /// **只探测不行动** —— ② 只看菜单项在不在、是不是灰的，不会真的去按一下，
    /// 所以诊断本身不会动用户的剪贴板。
    static func diagnostics(target: pid_t? = nil) -> [String] {
        var lines: [String] = []
        lines.append("辅助功能授权：\(Accessibility.isTrusted ? "已授权" : "未授权")")
        guard Accessibility.isTrusted else { return lines }

        guard let (pid, appName) = targetInfo(target) else {
            lines.append("目标应用：拿不到（没有正在运行的前台应用）")
            return lines
        }
        lines.append("目标应用：\(appName ?? "?")（pid \(pid)，bundle \(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "?")）")
        if pid == getpid() { lines.append("注意：目标就是本进程，后面的结果没有意义。") }

        if let capture = readViaAttributes(pid: pid, appName: appName) {
            let replacement = capture.element.map {
                Accessibility.isSettable($0, kAXSelectedTextAttribute) ? "可以" : "不行"
            } ?? "没有控件可用"
            lines.append("① AX 属性：读到 \(capture.text.count) 字 → \(clip(capture.text))")
            lines.append("   命中控件：\(describe(capture.element))")
            lines.append("   按这条通道原地替换：\(replacement)")
        } else {
            lines.append("① AX 属性：读不到（网页里的选区常见）")
        }

        if let item = findMenuItem(inApp: pid, command: "C", hints: copyTitles) {
            lines.append("② 菜单拷贝：找到「\(item.title)」，enabled=\(item.enabled)")
        } else {
            lines.append("② 菜单拷贝：菜单里没有拷贝项")
        }
        if let item = findMenuItem(inApp: pid, command: "V", hints: pasteTitles) {
            lines.append("   菜单粘贴：找到「\(item.title)」，enabled=\(item.enabled)")
        } else {
            lines.append("   菜单粘贴：菜单里没有粘贴项")
        }

        if let refusal = keystrokeRefusal(for: appName, pid: pid) {
            lines.append("③ 合成按键：拒绝执行 —— \(refusal)")
        } else {
            lines.append("③ 合成按键：可以执行")
        }

        switch targetKind(pid: pid) {
        case .editable: lines.append("目标位置：可写，回填能落进去")
        case .readOnly: lines.append("目标位置：只读，回填只能靠剪贴板")
        case .unknown: lines.append("目标位置：读不到焦点控件，无法判断")
        }
        return lines
    }

    private static func clip(_ text: String, limit: Int = 60) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: "⏎")
        return flat.count > limit ? String(flat.prefix(limit)) + "…" : flat
    }

    /// 排障用：命中的控件是什么、选区的文字是从哪条子路来的。
    private static func describe(_ element: AXUIElement?) -> String {
        guard let element else { return "无" }
        let role = Accessibility.string(element, kAXRoleAttribute) ?? "?"
        let subrole = Accessibility.string(element, kAXSubroleAttribute) ?? ""
        let direct = Accessibility.string(element, kAXSelectedTextAttribute) ?? ""
        let range = Accessibility.range(element, kAXSelectedTextRangeAttribute)
        let via = direct.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "AXStringForRange（范围 loc=\(range?.location ?? -1) len=\(range?.length ?? -1)）"
            : "AXSelectedText"
        return "\(role)\(subrole.isEmpty ? "" : "/\(subrole)")，文字来自 \(via)"
    }

    // MARK: - 读

    /// 读选中的文字。
    ///
    /// - Parameter target: 指定要读哪个 App（诊断用）。传 nil 就是「此刻的前台应用」——
    ///   正常使用时热键是在目标 App 前面按下的，所以前台正是它。
    static func read(target: pid_t? = nil) -> ReadResult {
        guard Accessibility.isTrusted else {
            return .no("需要「辅助功能」授权才能读别的 App 里选中的文字。")
        }
        guard let (pid, appName) = targetInfo(target) else {
            return .no("拿不到目标应用，稍等一下再试。")
        }
        guard pid != getpid() else {
            return .no("焦点在本应用上。先点回你要翻译的那个 App，再按热键。")
        }

        if let capture = readViaAttributes(pid: pid, appName: appName) {
            ltTrace("选区：AX 通道命中 \(capture.text.count) 字")
            return .ok(capture)
        }

        // 通道 2：按「编辑 › 拷贝」。找不到拷贝项才算这条走不通
        if let item = findMenuItem(inApp: pid, command: "C", hints: copyTitles) {
            guard item.enabled else {
                // enabled 就是「现在有没有选中东西」，不用碰剪贴板就能给准话
                ltTrace("选区：拷贝菜单项是灰的 → 判定没选中")
                return .no("没有选中任何文字。")
            }
            if let capture = copyViaMenuItem(item, pid: pid, appName: appName) {
                ltTrace("选区：菜单拷贝拿到 \(capture.text.count) 字")
                return .ok(capture)
            }
        }

        // 通道 3：合成 ⌘C
        if let protected = keystrokeRefusal(for: appName, pid: pid) {
            return .no(protected)
        }
        if let capture = copyViaKeystroke(pid: pid, appName: appName) {
            ltTrace("选区：模拟 ⌘C 拿到 \(capture.text.count) 字")
            return .ok(capture)
        }

        return .no("没有选中任何文字。")
    }

    /// 要读哪个 App 的选区：指定了就用指定的，否则用此刻的前台应用。
    private static func targetInfo(_ target: pid_t?) -> (pid_t, String?)? {
        if let target {
            guard let app = NSRunningApplication(processIdentifier: target) else { return nil }
            return (target, app.localizedName)
        }
        guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
        return (front.processIdentifier, front.localizedName)
    }

    /// 通道 1：问 AX 属性。
    ///
    /// 刻意**不开 Chromium 的辅助功能增强开关**：实测开了也读不到网页里的选区，
    /// 而那个开关会在对方进程里重建整棵节点树，为一个读不到的属性付这个代价不值。
    private static func readViaAttributes(pid: pid_t, appName: String?) -> Capture? {
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, 0.3)

        var focused = Accessibility.element(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute)
        if let candidate = focused, Accessibility.pid(of: candidate) != pid { focused = nil }
        if focused == nil {
            focused = Accessibility.element(appElement, kAXFocusedUIElementAttribute)
        }

        // 焦点元素连同它的祖先：原生 App 的选区就在这一条链上
        if let focused {
            var node: AXUIElement? = focused
            var depth = 0
            while let current = node, depth < 6 {
                if let text = selectedText(of: current) {
                    return Capture(
                        text: text, source: .accessibility, pid: pid, appName: appName,
                        element: current, anchor: frame(of: current)
                    )
                }
                node = Accessibility.element(current, kAXParentAttribute)
                depth += 1
            }
        }

        // 焦点落在列表上、选区却在阅读窗格里的情形：整棵窗口树再找一遍。
        // 树是有限深度加上限节点数的，最多几百次 AX 调用，可以接受。
        guard let window = Accessibility.element(appElement, kAXFocusedWindowAttribute)
            ?? Accessibility.element(appElement, kAXMainWindowAttribute) else { return nil }
        return findSelection(in: window, pid: pid, appName: appName)
    }

    /// 从控件上把选中的文字取出来。
    ///
    /// 先直接属性，再退到「给范围换子串」—— 后者是 Chromium 内部取文本的路径，
    /// 偶尔在前者空着的时候还能用。
    ///
    /// 只认**真正的文本控件**。这条限制是实测逼出来的：同一段选区，Chromium 在
    /// 网页容器（`AXWebArea`）上时有时无，报出来时还会把换行和制表符压平
    /// （`下单⇥03` → `下单03`）；而 `AXTextArea` 每次都准、内容一字不差。
    /// 与其赌容器上那次读，不如让它退到菜单通道 —— 那条实测稳定、内容完整，
    /// 只是多绕一步。宁可不读，也不能读错或者读残。
    private static func selectedText(of element: AXUIElement) -> String? {
        guard isEditableTextRole(element) else { return nil }
        if let text = Accessibility.string(element, kAXSelectedTextAttribute), isProse(text) { return text }
        guard let range = Accessibility.range(element, kAXSelectedTextRangeAttribute), range.length > 0 else { return nil }
        guard let text = Accessibility.stringForRange(element, range), isProse(text) else { return nil }
        return text
    }

    /// 走 AX 属性这条通道时认哪些控件。
    private static let editableTextRoles: Set<String> = [
        kAXTextAreaRole, kAXTextFieldRole, kAXComboBoxRole
    ]

    private static func isEditableTextRole(_ element: AXUIElement) -> Bool {
        guard let role = Accessibility.string(element, kAXRoleAttribute) else { return false }
        return editableTextRoles.contains(role)
    }

    private static func isProse(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func findSelection(in root: AXUIElement, pid: pid_t, appName: String?) -> Capture? {
        var queue: [AXUIElement] = [root]
        var visited = 0
        while !queue.isEmpty, visited < 1200 {
            let node = queue.removeFirst()
            visited += 1
            if let text = selectedText(of: node) {
                return Capture(
                    text: text, source: .accessibility, pid: pid, appName: appName,
                    element: node, anchor: frame(of: node)
                )
            }
            queue.append(contentsOf: Accessibility.elements(node, kAXChildrenAttribute))
        }
        return nil
    }

    private static func frame(of element: AXUIElement) -> CGRect? {
        guard let origin = Accessibility.point(element, kAXPositionAttribute),
              let size = Accessibility.size(element, kAXSizeAttribute),
              size.width > 0, size.height > 0 else { return nil }
        return CGRect(origin: origin, size: size)
    }

    // MARK: - 换

    /// 用译文替换掉之前读到的那个选区。
    ///
    /// 前提：调用方已经把这个 App 拉回前台了 —— 按菜单项和发按键都作用在
    /// 「当前 key window」上，App 不在前台就会打到别处去。
    ///
    /// 三条通道依次试，都失败才认输，并明确说清「译文已经在剪贴板里了」。
    static func replace(_ text: String, in capture: Capture) -> Accessibility.WriteResult {
        // 通道 1：AX 原地替换。不碰剪贴板，最干净
        if let element = capture.element, Accessibility.replaceSelection(text, in: element) == nil {
            return .init(ok: true, channel: .selectedText, error: nil)
        }

        guard Accessibility.isTrusted else {
            return .init(ok: false, channel: nil, error: "缺少辅助功能授权")
        }
        guard capture.pid != 0 else {
            return .init(ok: false, channel: nil, error: "目标应用已经退出了")
        }
        let pid = capture.pid

        // 只读的地方（邮件阅读窗格、网页正文）粘不进去。注意：这时**不要**假装成功，
        // 也不要把剪贴板还回去 —— 用户此刻唯一能拿到的就是剪贴板里这份译文。
        if targetKind(pid: pid) == .readOnly {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
            return .init(
                ok: false, channel: .paste,
                error: "这个位置是只读的，粘不进去。译文已经放进剪贴板，可以直接贴到别处。"
            )
        }

        let saved = savePasteboard()
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        // 通道 2：按目标 App 的「粘贴」菜单项。纯 AX，不会误触终端里的 ^C
        if let item = findMenuItem(inApp: pid, command: "V", hints: pasteTitles), item.enabled,
           AXUIElementPerformAction(item.element, kAXPressAction as CFString) == .success {
            settle()
            restorePasteboard(saved)
            return .init(ok: true, channel: .paste, error: nil)
        }

        // 通道 3：合成 ⌘V
        if let refusal = keystrokeRefusal(for: capture.appName, pid: pid) {
            restorePasteboard(saved)
            return .init(ok: false, channel: nil, error: "\(refusal)译文已经放进剪贴板，手动按一下 ⌘V 即可。")
        }
        postCommandKey(0x09)          // v
        settle()
        restorePasteboard(saved)
        return .init(ok: true, channel: .paste, error: nil)
    }

    private enum TargetKind { case editable, readOnly, unknown }

    /// 目标 App 的焦点处看起来能不能写。
    ///
    /// 这是**判断依据，不是闸门之外的东西**：实测在 Chrome 里点进 `<textarea>` 时焦点是
    /// `AXTextArea`（可写），而在只读页面里选区落在 `AXWebArea` 上（不可写）。
    /// 读不到焦点控件时返回 `.unknown`，那时按「可能可写」处理，不去拦着用户。
    private static func targetKind(pid: pid_t) -> TargetKind {
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, 0.3)
        guard let element = Accessibility.element(appElement, kAXFocusedUIElementAttribute) else {
            return .unknown
        }
        if Accessibility.isSettable(element, kAXValueAttribute) { return .editable }
        if Accessibility.isSettable(element, kAXSelectedTextAttribute) { return .editable }
        return .readOnly
    }

    /// 等目标应用把这次拷贝/粘贴处理完。都是它自己的事件处理循环里同步完成的事，
    /// 留这点时间只是不跟它抢，不是「等它慢慢来」。
    private static func settle() {
        Thread.sleep(forTimeInterval: 0.45)
    }

    // MARK: - 通道 2：按别的 App 的菜单项

    private static let copyTitles = ["复制", "拷贝", "Copy"]
    private static let pasteTitles = ["粘贴", "Paste"]

    struct MenuItem {
        let element: AXUIElement
        let title: String
        let enabled: Bool
    }

    /// 在目标 App 的菜单栏里找一项。
    ///
    /// 首选按**快捷键**认（`AXMenuItemCmdChar` + 修饰键为 0，也就是纯 ⌘），
    /// 因为那跟界面语言无关；只有实在没有快捷键时才退到按标题认。
    /// 这一步不做不行：Chrome 里 `cmd=C` 的项有三个，「窗口 › 居中」和
    /// 「检查元素」都带 C，靠修饰键才分得开。
    static func findMenuItem(inApp pid: pid_t, command: String, hints: [String]) -> MenuItem? {
        let appElement = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appElement, 0.5)
        guard let bar = Accessibility.element(appElement, kAXMenuBarAttribute) else { return nil }

        var exact: MenuItem?
        var hinted: MenuItem?
        var queue: [AXUIElement] = [bar]
        var visited = 0

        while !queue.isEmpty, visited < 2500 {
            let node = queue.removeFirst()
            visited += 1

            let isItem = Accessibility.string(node, kAXRoleAttribute) == (kAXMenuItemRole as String)
            if isItem {
                let title = Accessibility.string(node, kAXTitleAttribute) ?? ""
                let item = MenuItem(
                    element: node,
                    title: title,
                    enabled: Accessibility.flag(node, kAXEnabledAttribute)
                )
                // "AXMenuItemCmdChar" / "AXMenuItemCmdModifiers"，值分别是字母和修饰键掩码；
                // 0 表示只有 ⌘，1 是 ⇧，2 是 ⌥，4 是 ⌃
                let cmd = Accessibility.string(node, "AXMenuItemCmdChar") ?? ""
                let mods = Accessibility.number(node, "AXMenuItemCmdModifiers") ?? 0

                if cmd.uppercased() == command.uppercased() {
                    if mods == 0 { exact = exact ?? item }
                    else if exact == nil, matches(title, hints) { hinted = hinted ?? item }
                } else if exact == nil, cmd.isEmpty, matches(title, hints) {
                    hinted = hinted ?? item
                }
            }

            // 菜单项的子节点是它的子菜单，继续走下去才能覆盖嵌套菜单
            queue.append(contentsOf: Accessibility.elements(node, kAXChildrenAttribute))
        }

        return exact ?? hinted
    }

    private static func matches(_ title: String, _ hints: [String]) -> Bool {
        hints.contains { title.localizedCaseInsensitiveContains($0) }
    }

    /// 按菜单项拷贝，并把它放进剪贴板的东西取出来。
    private static func copyViaMenuItem(_ item: MenuItem, pid: pid_t, appName: String?) -> Capture? {
        let saved = savePasteboard()
        let pasteboard = NSPasteboard.general
        let before = pasteboard.changeCount

        guard AXUIElementPerformAction(item.element, kAXPressAction as CFString) == .success else {
            restorePasteboard(saved)
            return nil
        }
        guard let text = waitForNewPasteboard(since: before), isProse(text) else {
            restorePasteboard(saved)
            return nil
        }
        restorePasteboard(saved)
        return Capture(text: text, source: .menu, pid: pid, appName: appName, element: nil, anchor: nil)
    }

    // MARK: - 通道 3：合成按键

    /// 这些应用里 ⌘C / ⌘V 未必是拷贝粘贴，可能被绑成「把控制字符打进终端」。
    /// 替用户发一次按键就等于往他的 shell 里塞东西，所以直接拒绝，宁可失败。
    private static let keystrokeUnsafeBundleIDs: Set<String> = [
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "dev.warp.Warp-Stable",
        "io.alacritty",
        "net.kovidgoyal.kitty",
        "com.github.wez.wezterm",
        "co.zeit.hyper",
        "org.tabby"
    ]

    private static func keystrokeRefusal(for appName: String?, pid: pid_t) -> String? {
        guard let bundleID = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier,
              keystrokeUnsafeBundleIDs.contains(bundleID) else { return nil }
        return "\(appName ?? "这个应用")是终端，⌘C / ⌘V 可能被绑成发送控制字符，不敢替你按。"
            + "请改用浏览器扩展读网页，或手动全选后按「翻译当前输入框」。"
    }

    private static func copyViaKeystroke(pid: pid_t, appName: String?) -> Capture? {
        guard NSRunningApplication(processIdentifier: pid) != nil else { return nil }
        activateAndWait(pid)

        let saved = savePasteboard()
        let pasteboard = NSPasteboard.general
        let before = pasteboard.changeCount

        postCommandKey(0x08)          // c
        guard let text = waitForNewPasteboard(since: before), isProse(text) else {
            restorePasteboard(saved)
            return nil
        }
        restorePasteboard(saved)
        return Capture(text: text, source: .keystroke, pid: pid, appName: appName, element: nil, anchor: nil)
    }

    /// 等剪贴板真的被对方写进来。用轮询代替固定等待：快的时候 20 毫秒就回来了，
    /// 慢的应用也不用靠「睡久一点」硬扛。
    private static func waitForNewPasteboard(since changeCount: Int, timeout: TimeInterval = 0.7) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        let pasteboard = NSPasteboard.general
        while Date() < deadline {
            if pasteboard.changeCount != changeCount {
                return pasteboard.string(forType: .string)
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return nil
    }

    private static func postCommandKey(_ code: CGKeyCode) {
        let source = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    // MARK: - 剪贴板

    /// 存一份剪贴板。读选区和替换选区都要临时借用剪贴板，
    /// 借完必须还回去 —— 用户的东西不该因为我们读一段文字就没了。
    private static func savePasteboard() -> [NSPasteboardItem] {
        (NSPasteboard.general.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
    }

    private static func restorePasteboard(_ items: [NSPasteboardItem]) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        guard !items.isEmpty else { return }
        pasteboard.writeObjects(items)
    }
}

extension NSRunningApplication {
    /// 把目标 App 拉回前台。
    /// 结果浮层是能成为 key 的面板，所以回填前要主动把前台让回给它。
    func bringToFront() {
        if #available(macOS 14.0, *) {
            activate()
        } else {
            activate(options: [.activateAllWindows])
        }
    }
}

/// 把某个 App 提到最前，并等它**真的**成为前台应用再返回。
///
/// 只 activate 不等待是不行的：切换有延迟，紧接着发的按键会打到上一个应用身上。
func activateAndWait(_ pid: pid_t, timeout: TimeInterval = 0.7) {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return }
    app.bringToFront()

    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return }
        Thread.sleep(forTimeInterval: 0.02)
    }
}
