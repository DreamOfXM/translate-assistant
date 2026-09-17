import AppKit
import SwiftUI

/**
 结果浮层。

 最重要的约束：**不能抢走目标 App 的焦点**。用 `.nonactivatingPanel` 面板
 —— 它能成为 key window（因此 Return / Esc 快捷键可用），但不会把本 App 激活，
 目标 App 仍然是前台应用，AX 回填才有落脚点。为了万无一失，回填前还会再
 主动激活一次目标 App（见 AppDelegate.fillBack）。

 位置：由热键触发时贴在屏幕上方居中；由输入框旁的小浮标触发时会传 `near`，
 那时贴着那个输入框摆 —— 先试下方，放不下就上方，再不行左右，
 最后才退回屏幕上方居中。邮件回复框往往占掉大半个屏幕，只有左右还有位置。
 */
@MainActor
final class HUDModel: ObservableObject {
    @Published var original = ""
    @Published var translated = ""
    @Published var status = ""
    @Published var warning = ""
    @Published var busy = false
    @Published var isError = false

    var onFill: (() -> Void)?
    var onCopy: (() -> Void)?
    var onRetry: (() -> Void)?
    var onClose: (() -> Void)?
}

@MainActor
final class HUDController {

    private let model = HUDModel()
    private var panel: HUDWindow?
    /// 触发本次翻译的输入框（AX 坐标）。有值时浮层贴着它摆
    private var anchor: CGRect?

    var translatedText: String { model.translated }
    var isVisible: Bool { panel?.isVisible ?? false }

    /// 面板尺寸。`HUDView` 也要用同一个值，所以不能是 private
    static let size = NSSize(width: 468, height: 380)

    func bind(onFill: @escaping () -> Void,
              onCopy: @escaping () -> Void,
              onRetry: @escaping () -> Void,
              onClose: @escaping () -> Void) {
        model.onFill = onFill
        model.onCopy = onCopy
        model.onRetry = onRetry
        model.onClose = onClose
    }

    func show(original: String, status: String, near anchor: CGRect? = nil) {
        self.anchor = anchor
        model.original = original
        model.translated = ""
        model.status = status
        model.warning = ""
        model.busy = true
        model.isError = false
        present()
    }

    func update(translated: String, status: String, warning: String = "") {
        model.translated = translated
        model.status = status
        model.warning = warning
        model.busy = false
        model.isError = false
    }

    func fail(_ message: String) {
        model.status = message
        model.warning = ""
        model.busy = false
        model.isError = true
    }

    /// 只报一句提示，没有原文也没有译文（读不到输入框、缺授权之类）
    func notice(_ message: String) {
        model.original = ""
        model.translated = ""
        model.warning = ""
        model.busy = false
        model.isError = true
        model.status = message
        present()
    }

    func setStatus(_ status: String) {
        model.status = status
    }

    func close() {
        panel?.orderOut(nil)
        anchor = nil
    }

    private func present() {
        let panel = panel ?? makePanel()
        self.panel = panel
        panel.setContentSize(Self.size)
        position(panel)
        // orderFrontRegardless 不激活本 App，只是把面板显示出来
        panel.orderFrontRegardless()
    }

    private func makePanel() -> HUDWindow {
        let panel = HUDWindow(
            contentRect: NSRect(origin: .zero, size: Self.size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = NSHostingView(rootView: HUDView(model: model))
        return panel
    }

    private func position(_ panel: NSPanel) {
        let size = panel.frame.size
        if let anchor {
            panel.setFrameOrigin(origin(beside: anchor, size: size))
            return
        }

        // 没有锚点（热键触发）：放在鼠标所在屏幕靠上的位置
        let visible = visibleFrame(containing: NSEvent.mouseLocation)
        panel.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.maxY - size.height - 80))
    }

    /// 贴着输入框摆。顺序是「下 → 上 → 右 → 左」，四个方向都放不下才回退到屏幕上方居中。
    private func origin(beside axFrame: CGRect, size: NSSize) -> NSPoint {
        let anchor = Accessibility.appKitRect(fromAX: axFrame)
        let visible = visibleFrame(containing: CGPoint(x: anchor.midX, y: anchor.midY))
        let gap: CGFloat = 8

        let candidates = [
            NSPoint(x: anchor.minX, y: anchor.minY - size.height - gap),                 // 下方
            NSPoint(x: anchor.minX, y: anchor.maxY + gap),                               // 上方
            NSPoint(x: anchor.maxX + gap, y: anchor.maxY - size.height),                 // 右侧
            NSPoint(x: anchor.minX - size.width - gap, y: anchor.maxY - size.height)     // 左侧
        ]
        for origin in candidates where visible.contains(CGRect(origin: origin, size: size)) {
            return origin
        }
        return NSPoint(x: visible.midX - size.width / 2, y: visible.maxY - size.height - 80)
    }

    private func visibleFrame(containing point: CGPoint) -> CGRect {
        let screen = NSScreen.screens.first { NSMouseInRect(point, $0.frame, false) } ?? NSScreen.main
        return screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
    }

    private final class HUDWindow: NSPanel {
        // 非激活面板：能成为 key 以接收 Return / Esc，但不会激活 App
        override var canBecomeKey: Bool { true }
    }
}

struct HUDView: View {

    @ObservedObject var model: HUDModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            block(title: "原文", text: model.original, placeholder: "—")
            block(title: "译文", text: model.translated, placeholder: model.busy ? "翻译中…" : "—")
            if !model.warning.isEmpty {
                Text(model.warning)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.orange)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            footer
        }
        .padding(14)
        .frame(width: HUDController.size.width, height: HUDController.size.height)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.primary.opacity(0.12), lineWidth: 0.5)
        )
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("翻译助手")
                .font(.system(size: 13, weight: .medium))
            Spacer(minLength: 12)
            Text(model.status)
                .font(.system(size: 11))
                .foregroundStyle(model.isError ? Color.red : Color.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private func block(title: String, text: String, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            ScrollView {
                Text(text.isEmpty ? placeholder : text)
                    .font(.system(size: 13))
                    .textSelection(.enabled)
                    .foregroundStyle(text.isEmpty ? Color.secondary : Color.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(height: 84)
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Button("重新翻译") { model.onRetry?() }
                .disabled(model.busy)
            Spacer()
            Button("复制") { model.onCopy?() }
                .disabled(model.translated.isEmpty)
            Button("填入") { model.onFill?() }
                .disabled(model.translated.isEmpty)
                .keyboardShortcut(.defaultAction)
            Button("关闭") { model.onClose?() }
                .keyboardShortcut(.cancelAction)
        }
        .controlSize(.small)
    }
}
