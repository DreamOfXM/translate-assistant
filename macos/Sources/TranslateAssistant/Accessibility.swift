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

        return withAccessibilityBoost(pid: focused.pid) {
            let element = focused.element
            guard !isOwnProcess(focused.pid) else { return nil }

            let value = string(element, kAXValueAttribute)
            let selected = string(element, kAXSelectedTextAttribute)

            // 整框和选区都读不到，说明这个控件根本不暴露文本，没必要往下走
            if value == nil && selected == nil { return nil }

            return FieldSnapshot(
                element: element,
                pid: focused.pid,
                appName: NSRunningApplication(processIdentifier: focused.pid)?.localizedName,
                role: string(element, kAXRoleAttribute),
                value: value,
                selectedText: selected,
                selectedRange: range(element, kAXSelectedTextRangeAttribute),
                valueSettable: isSettable(element, kAXValueAttribute),
                selectedTextSettable: isSettable(element, kAXSelectedTextAttribute)
            )
        }
    }

    // MARK: - 写回

    enum WriteChannel: String {
        case value = "整框覆写"
        case selectedText = "替换选区"
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

    static func range(_ element: AXUIElement, _ attribute: String) -> NSRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let raw = value, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var cfRange = CFRange()
        guard AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cfRange, &cfRange) else { return nil }
        return NSRange(location: cfRange.location, length: cfRange.length)
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
