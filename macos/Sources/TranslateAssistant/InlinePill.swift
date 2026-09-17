import AppKit

/**
 输入框旁边的常驻小浮标。

 **它不是「注入对方界面的控件」。** macOS 不允许一个进程往另一个进程的视图树里
 塞东西，所以做法是我方进程的一个无边框、非激活面板，**盖在**输入框右上角上 ——
 位置由 AX 读到的输入框矩形算出来，窗口一动就要重新定位（见 `FocusTracker`）。

 两条必须守住的约束：

 - **不抢焦点**：面板 `canBecomeKey = false` 且用 `orderFrontRegardless` 显示，
   点它不会把前台应用切换走。否则点完按钮，原来的输入框已经不是焦点了，
   回填会找不到落脚点。
 - **不盖住正文**：贴在右上角内侧而不是压在光标附近。光标通常在输入框底部，
   那里才是用户视线所在。
 */
@MainActor
final class InlinePill {

    /// 点一下浮标
    var onClick: (() -> Void)?

    private var panel: NSPanel?
    private var pillView: PillView?

    private let size = NSSize(width: 32, height: 32)
    /// 相对输入框右上角往里收这么多，避免和对方自己的边框贴在一起
    private let inset: CGFloat = 8

    var isVisible: Bool { panel?.isVisible ?? false }

    /// - Parameter axFrame: 输入框在 AX 坐标系（主屏左上为原点）里的矩形
    func show(at axFrame: CGRect) {
        let panel = panel ?? makePanel()
        self.panel = panel
        panel.setFrameOrigin(origin(for: axFrame))
        panel.orderFrontRegardless()
    }

    /// 跟着输入框走。位置没变就别动窗口，避免无谓的重画抖动
    func move(to axFrame: CGRect) {
        guard let panel, panel.isVisible else { return }
        let target = origin(for: axFrame)
        guard panel.frame.origin != target else { return }
        panel.setFrameOrigin(target)
    }

    func hide() {
        panel?.orderOut(nil)
    }

    // MARK: - 定位

    private func origin(for axFrame: CGRect) -> NSPoint {
        let rect = Accessibility.appKitRect(fromAX: axFrame)
        var origin = NSPoint(
            x: rect.maxX - size.width - inset,
            y: rect.maxY - size.height - inset
        )

        // 输入框贴着屏幕边（比如全屏）时往回收一点，别把按钮挤到屏幕外
        let visible = Accessibility.activeVisibleFrame
        origin.x = min(max(origin.x, visible.minX + 4), visible.maxX - size.width - 4)
        origin.y = min(max(origin.y, visible.minY + 4), visible.maxY - size.height - 4)
        return origin
    }

    // MARK: - 面板

    private func makePanel() -> NSPanel {
        let panel = PillWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true

        let view = PillView(frame: NSRect(origin: .zero, size: size))
        view.autoresizingMask = [.width, .height]
        view.onClick = { [weak self] in self?.onClick?() }
        panel.contentView = view
        pillView = view
        return panel
    }

    private final class PillWindow: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    /// 自绘的圆角按钮。用 `mouseDown` 直接收点击，不依赖窗口成为 key。
    private final class PillView: NSView {

        var onClick: (() -> Void)?

        private var hovering = false
        private var trackingArea: NSTrackingArea?

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let trackingArea { removeTrackingArea(trackingArea) }
            let area = NSTrackingArea(
                rect: bounds,
                options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
                owner: self,
                userInfo: nil
            )
            addTrackingArea(area)
            trackingArea = area
        }

        override func mouseEntered(with event: NSEvent) {
            hovering = true
            needsDisplay = true
        }

        override func mouseExited(with event: NSEvent) {
            hovering = false
            needsDisplay = true
        }

        override func mouseDown(with event: NSEvent) {
            onClick?()
        }

        override func resetCursorRects() {
            addCursorRect(bounds, cursor: .pointingHand)
        }

        override func draw(_ dirtyRect: NSRect) {
            let body = bounds.insetBy(dx: 1, dy: 1)
            let path = NSBezierPath(roundedRect: body, xRadius: 9, yRadius: 9)

            let fill = hovering
                ? NSColor.controlAccentColor.highlight(withLevel: 0.15) ?? .controlAccentColor
                : NSColor.controlAccentColor
            fill.setFill()
            path.fill()

            NSColor.white.withAlphaComponent(0.4).setStroke()
            path.lineWidth = 1
            path.stroke()

            let text = "译" as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
                .foregroundColor: NSColor.white
            ]
            let textSize = text.size(withAttributes: attributes)
            text.draw(
                at: NSPoint(x: bounds.midX - textSize.width / 2, y: bounds.midY - textSize.height / 2),
                withAttributes: attributes
            )
        }
    }
}
