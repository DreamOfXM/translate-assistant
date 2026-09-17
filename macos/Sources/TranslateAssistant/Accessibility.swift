import AppKit
import ApplicationServices

/**
 无障碍（Accessibility）层：读写「任何 App 当前焦点所在的输入框」。

 与浏览器扩展的根本区别就在这里 —— 扩展只能看见自己注入的那个网页，
 而 AX API 是操作系统提供的，它看到的输入框来自任何进程：原生 App、
 网页浏览器、Electron 应用。代价是必须拿到「辅助功能」授权。

 两条通道：
 - 读：kAXValueAttribute 拿整框文本；kAXSelectedTextAttribute 拿选区。
 - 写：优先 kAXValueAttribute 整框覆写；不可写时退回 kAXSelectedTextAttribute
   替换选区（这条在部分 Web / Electron 输入框里反而可用）。

 均需在已授权的前提下调用，否则所有 AX 调用一律返回 .apiDisabled。
 */
enum Accessibility {

    // MARK: - 授权

    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// 弹系统授权对话框（只会弹一次），并返回当前状态。首次调用后用户需要去
    /// 系统设置里手动勾选，勾完一般要重启本 App 才生效。
    @discardableResult
    static func requestTrust(prompt: Bool = true) -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
    }

    static func openSystemSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        NSWorkspace.shared.open(url)
    }

    // MARK: - 快照

    struct FieldSnapshot {
        let element: AXUIElement
        let pid: pid_t
        let appName: String?
        let role: String?
        let value: String?
        let selectedText: String?
        let selectedRange: NSRange?
        let valueSettable: Bool
        let selectedTextSettable: Bool

        /// 整框文本（读不到就是空串）
        var text: String { value ?? "" }

        var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

        /// 我们只处理「有内容的输入框」；选区和整框都没有才叫读不到
        var hasText: Bool { !trimmed.isEmpty }

        var hasSelection: Bool {
            guard let range = selectedRange else { return false }
            return range.length > 0
        }

        /// 用哪条通道写回
        var writableChannel: String? {
            if valueSettable { return "整框覆写" }
            if selectedTextSettable { return "替换选区" }
            return nil
        }
    }

    /// 读一次当前焦点输入框。
    ///
    /// 对 Chromium / Electron 会临时打开辅助功能增强开关 —— 这类应用平时
    /// 不构建完整的无障碍节点树（省性能），不打开就读不到输入框内容。
    /// 读完复原，避免长期挂在那里拖慢对方。
    static func snapshot() -> FieldSnapshot? {
        guard isTrusted else { return nil }
        guard let focused = focusedElement() else { return nil }
        guard !isOwnProcess(focused.pid) else { return nil }

        return withAccessibilityBoost(pid: focused.pid) {
            makeSnapshot(element: focused.element, pid: focused.pid)
        }
    }

    /// 按「已知的那个控件」取快照。
    ///
    /// 输入框旁的小浮标点的是它旁边这个输入框，此时不该再去问系统焦点 ——
    /// 用户的手可能已经点到别处了，再问一次就会翻译错对象。
    static func snapshot(of geometry: FieldGeometry) -> FieldSnapshot? {
        guard isTrusted else { return nil }
        return withAccessibilityBoost(pid: geometry.pid) {
            makeSnapshot(element: geometry.element, pid: geometry.pid)
        }
    }

    private static func makeSnapshot(element: AXUIElement, pid: pid_t) -> FieldSnapshot? {
        let value = string(element, kAXValueAttribute)
        let selected = string(element, kAXSelectedTextAttribute)

        // 整框和选区都读不到，说明这个控件根本不暴露文本，没必要往下走
        if value == nil && selected == nil { return nil }

        return FieldSnapshot(
            element: element,
            pid: pid,
            appName: NSRunningApplication(processIdentifier: pid)?.localizedName,
            role: string(element, kAXRoleAttribute),
            value: value,
            selectedText: selected,
            selectedRange: range(element, kAXSelectedTextRangeAttribute),
            valueSettable: isSettable(element, kAXValueAttribute),
            selectedTextSettable: isSettable(element, kAXSelectedTextAttribute)
        )
    }

    // MARK: - 焦点输入框的位置

    /// 一个可输入的焦点控件的位置。
    ///
    /// 刻意**不带内容**：小浮标只需要知道按钮该画在哪，所以这条路径不去读
    /// `kAXValue`。它会被高频调用（跟随窗口移动），顺便把用户的草稿读一遍
    /// 既没必要也不礼貌。真正要用内容时走 `snapshot(of:)`。
    struct FieldGeometry {
        let element: AXUIElement
        let pid: pid_t
        let appName: String?
        let role: String?
        /// AX 坐标：原点在**主屏左上角**，与 AppKit 的左下原点相反，用之前要换算
        let frame: CGRect

        var isMultiline: Bool { role == (kAXTextAreaRole as String) }
    }

    /// 问某个进程「你内部焦点落在哪个可输入控件上」，只读它的位置。
    ///
    /// 这里**不打开 Chromium / Electron 的辅助功能增强开关**：那个开关是给
    /// 「读内容」用的，而跟随光标是个持续动作，反复开关只会让对方的节点树闪断。
    /// 原生暴露输入框的应用（备忘录、邮件客户端、iTerm 等）不需要它也能读到位置。
    static func focusedFieldGeometry(inApp pid: pid_t) -> FieldGeometry? {
        guard isTrusted else { return nil }
        guard !isOwnProcess(pid) else { return nil }

        let appElement = AXUIElementCreateApplication(pid)
        // 跟随光标是高频动作，万一目标应用正忙，AX 调用会同步阻塞我们。
        // 卡住自己的主线程比晚一点画按钮糟糕得多，所以把等待压到很短。
        AXUIElementSetMessagingTimeout(appElement, 0.25)
        guard let element = element(appElement, kAXFocusedUIElementAttribute) else { return nil }
        guard let role = string(element, kAXRoleAttribute) else { return nil }
        guard role == (kAXTextAreaRole as String) || role == (kAXTextFieldRole as String) else { return nil }

        // 只读的文本框（网页正文之类）不该挂翻译按钮
        let editable = isSettable(element, kAXValueAttribute) || isSettable(element, kAXSelectedTextAttribute)
        guard editable else { return nil }

        guard let origin = point(element, kAXPositionAttribute),
              let size = size(element, kAXSizeAttribute) else { return nil }
        let frame = CGRect(origin: origin, size: size)

        // 路过的搜索框、单行小控件不挂，太吵
        guard frame.width >= 120, frame.height >= 22 else { return nil }

        return FieldGeometry(
            element: element,
            pid: pid,
            appName: NSRunningApplication(processIdentifier: pid)?.localizedName,
            role: role,
            frame: frame
        )
    }

    // MARK: - 写回

    /// 把译文原地替换掉那个选区。
    ///
    /// 同样**不做通道回退**：写不进选区就只有「没写进去」这一种结果，绝不去动整框。
    /// 返回 nil 表示成功，否则是给人看的原因。
    static func replaceSelection(_ text: String, in element: AXUIElement) -> String? {
        guard isTrusted else { return "缺少辅助功能授权" }
        guard isSettable(element, kAXSelectedTextAttribute) else { return "这个位置不支持原地替换" }
        return set(element, kAXSelectedTextAttribute, text as CFString)
    }

    enum WriteChannel: String {
        case value = "整框覆写"
        case selectedText = "替换选区"
        /// 目标 App 的选区不在 AX 可见的控件上（网页内容），只能靠粘贴进去
        case paste = "粘贴回填"
    }

    struct WriteResult {
        let ok: Bool
        let channel: WriteChannel?
        let error: String?
    }

    /// 把译文写回原输入框。
    ///
    /// - Parameter preferring: 用哪条通道。翻译「选中文字」时传 `.selectedText`，
    ///   否则整框覆写会把用户没选中的部分一起冲掉。
    ///
    /// 故意**不做通道回退**。两条通道的后果完全不同：整框覆写会抹掉草稿里其余内容，
    /// 而往光标处写整段译文只会把草稿搞乱。对邮件、聊天这类地方，
    /// 「失败并让用户手动复制」远好过「悄悄毁掉他写了一半的正文」。
    static func write(_ text: String, into snapshot: FieldSnapshot, preferring preferred: WriteChannel? = nil) -> WriteResult {
        guard isTrusted else {
            return WriteResult(ok: false, channel: nil, error: "缺少辅助功能授权")
        }

        let channel = preferred ?? .value
        let settable = channel == .value ? snapshot.valueSettable : snapshot.selectedTextSettable

        guard settable else {
            let hint = channel == .value
                ? "可以先全选，再用「翻译选中文字」"
                : "可以改用复制，或先全选再用「翻译当前输入框」"
            return WriteResult(ok: false, channel: nil, error: "这个输入框不支持\(channel.rawValue)（\(hint)）")
        }

        let attribute = channel == .value ? kAXValueAttribute : kAXSelectedTextAttribute
        if let error = set(snapshot.element, attribute, text as CFString) {
            return WriteResult(ok: false, channel: nil, error: "\(channel.rawValue)失败（\(error)）")
        }
        return WriteResult(ok: true, channel: channel, error: nil)
    }

    // MARK: - 焦点元素

    struct FocusedElement {
        let element: AXUIElement
        let pid: pid_t
    }

    private static func focusedElement() -> FocusedElement? {
        // 优先问系统级：它给的是「全局焦点」。
        let system = AXUIElementCreateSystemWide()
        if let element = element(system, kAXFocusedUIElementAttribute) {
            if let pid = pid(of: element) { return FocusedElement(element: element, pid: pid) }
        }

        // 系统级拿不到时（部分 App 不往系统级注册焦点），退一步问前台应用。
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        guard let element = element(appElement, kAXFocusedUIElementAttribute) else { return nil }
        return FocusedElement(element: element, pid: app.processIdentifier)
    }

    private static func isOwnProcess(_ pid: pid_t) -> Bool { pid == getpid() }

    // MARK: - Chromium / Electron 增强开关

    private static func withAccessibilityBoost<T>(pid: pid_t, _ body: () -> T) -> T {
        let appElement = AXUIElementCreateApplication(pid)
        let manual = restoreTarget(appElement, "AXManualAccessibility")
        let enhanced = restoreTarget(appElement, "AXEnhancedUserInterface")

        AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

        defer {
            if let value = manual { AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, value) }
            if let value = enhanced { AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, value) }
        }
        return body()
    }

    /// 记下原值用于复原；本来就没这个属性就返回 nil，复原时也就什么都不做。
    private static func restoreTarget(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    // MARK: - AX 基本操作

    static func element(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let raw = value, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(raw, to: AXUIElement.self)
    }

    static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        if let text = value as? String { return text }
        // 少数控件把数值属性回成 NSNumber，转一下更好用
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    /// 按范围取子串。这是**参数化属性**，不是普通属性，所以单独走一个 API。
    ///
    /// 少数控件（尤其是内嵌网页里的编辑器）`AXSelectedText` 空着，但给它一个
    /// `AXSelectedTextRange` 它能照着范围把文字吐出来 —— 这是 Chromium 内部
    /// 自己的取 текст路径，值得试一次。
    static func stringForRange(_ element: AXUIElement, _ range: NSRange) -> String? {
        var cfRange = CFRange(location: range.location, length: range.length)
        guard let value = AXValueCreate(.cfRange, &cfRange) else { return nil }
        var out: CFTypeRef?
        let error = AXUIElementCopyParameterizedAttributeValue(
            element, "AXStringForRange" as CFString, value, &out
        )
        guard error == .success else { return nil }
        return out as? String
    }

    /// 原始属性值。布尔/数值属性都从这儿取，省得每个都写一遍同样的样板。
    static func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    static func number(_ element: AXUIElement, _ attribute: String) -> Int? {
        (value(element, attribute) as? NSNumber)?.intValue
    }

    /// 读一个开关型属性。读不到时算 `true` —— 需要在「读不到」和「明确关掉」
    /// 之间做区分时，宁可当作可用，让上层真的去试一次。
    static func flag(_ element: AXUIElement, _ attribute: String) -> Bool {
        guard let number = value(element, attribute) as? NSNumber else { return true }
        return number.boolValue
    }

    /// 取一个「元素数组」型属性（`AXChildren`、`AXWindows` 之类）。
    static func elements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
        guard let raw = value(element, attribute), CFGetTypeID(raw) == CFArrayGetTypeID() else { return [] }
        let list = unsafeBitCast(raw, to: CFArray.self) as NSArray
        return list.compactMap { item in
            guard CFGetTypeID(item as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
            return unsafeBitCast(item as CFTypeRef, to: AXUIElement.self)
        }
    }

    static func range(_ element: AXUIElement, _ attribute: String) -> NSRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let raw = value, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var cfRange = CFRange()
        guard AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cfRange, &cfRange) else { return nil }
        return NSRange(location: cfRange.location, length: cfRange.length)
    }

    static func point(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let raw = value, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        guard AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cgPoint, &point) else { return nil }
        return point
    }

    static func size(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let raw = value, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cgSize, &size) else { return nil }
        return size
    }

    // MARK: - 坐标换算

    /// AX 坐标（主屏左上为原点）→ AppKit 坐标（主屏左下为原点）。
    ///
    /// 两套坐标系的 Y 是反的，直接把 AX 的 y 交给窗口会跑到屏幕外。
    /// 多屏时以**最高那条边**为准：AX 的原点永远在主屏左上，而主屏在 AppKit 里
    /// 未必是最高的那块（副屏可能挂在上方）。
    static func appKitRect(fromAX rect: CGRect) -> CGRect {
        let top = NSScreen.screens.map { $0.frame.maxY }.max() ?? 0
        return CGRect(
            x: rect.minX,
            y: top - rect.maxY,
            width: rect.width,
            height: rect.height
        )
    }

    /// 当前鼠标所在屏幕的可见区域，用来把浮层挤回屏幕内
    static var activeVisibleFrame: CGRect {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        return screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
    }

    static func pid(of element: AXUIElement) -> pid_t? {
        var value: pid_t = 0
        guard AXUIElementGetPid(element, &value) == .success else { return nil }
        return value
    }

    static func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var flag: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(element, attribute as CFString, &flag) == .success else { return false }
        return flag.boolValue
    }

    private static func set(_ element: AXUIElement, _ attribute: String, _ value: CFTypeRef) -> String? {
        let error = AXUIElementSetAttributeValue(element, attribute as CFString, value)
        return error == .success ? nil : humanize(error)
    }

    static func humanize(_ error: AXError) -> String {
        switch error {
        case .apiDisabled: return "辅助功能未授权"
        case .notImplemented: return "对方未实现该属性"
        case .attributeUnsupported: return "对方不支持该属性"
        case .illegalArgument: return "参数不合法"
        case .invalidUIElement: return "目标控件已失效"
        case .cannotComplete: return "对方无响应"
        case .failure: return "操作失败"
        default: return "AXError \(error.rawValue)"
        }
    }

    // MARK: - 自检

    /// 给 `--self-check` 用：把当前焦点控件的可读可写属性全列出来，
    /// 用户在一句话说不清的 App 上报问题时，直接把这行复制过来。
    static func diagnostics() -> [String] {
        var lines: [String] = []
        lines.append("辅助功能授权：\(isTrusted ? "已授权" : "未授权")")
        lines.append("本进程 pid：\(getpid())")

        guard isTrusted else {
            lines.append("未授权，AX 调用会全部返回 apiDisabled。")
            lines.append("授权路径：系统设置 → 隐私与安全性 → 辅助功能 → 勾选本 App。")
            return lines
        }

        guard let focused = focusedElement() else {
            lines.append("当前没有可读的焦点控件（先把光标放进某个输入框再自检）。")
            return lines
        }

        lines.append("目标进程：\(NSRunningApplication(processIdentifier: focused.pid)?.localizedName ?? "?")（pid \(focused.pid)）")

        // 层级能区分原生编辑器与内嵌网页编辑器：后者会出现 AXWebArea。
        // 这两类控件的可写属性差别很大，排障时一眼就能看出来。
        var chain: [String] = []
        var node: AXUIElement? = focused.element
        while let current = node, chain.count < 6 {
            let role = string(current, kAXRoleAttribute) ?? "?"
            if let subrole = string(current, kAXSubroleAttribute) {
                chain.append("\(role)/\(subrole)")
            } else {
                chain.append(role)
            }
            node = element(current, kAXParentAttribute)
        }
        lines.append("焦点控件层级：\(chain.joined(separator: " ← "))")

        if let value = string(focused.element, kAXValueAttribute) {
            let flattened = value.replacingOccurrences(of: "\n", with: "⏎")
            let clipped = flattened.count > 60 ? String(flattened.prefix(60)) + "…" : flattened
            lines.append("当前值（\(value.count) 字）：\(clipped)")
        } else {
            lines.append("当前值：读不到 kAXValue")
        }

        let valueSettable = isSettable(focused.element, kAXValueAttribute)
        let selectionSettable = isSettable(focused.element, kAXSelectedTextAttribute)
        lines.append("写回通道：整框覆写 \(valueSettable ? "可写" : "不可写")、替换选区 \(selectionSettable ? "可写" : "不可写")")

        var names: CFArray?
        if AXUIElementCopyAttributeNames(focused.element, &names) == .success, let list = names as? [String] {
            let writable = list.filter { isSettable(focused.element, $0) }.sorted()
            lines.append("全部可写属性：\(writable.isEmpty ? "无" : writable.joined(separator: ", "))")
        }
        return lines
    }
}
