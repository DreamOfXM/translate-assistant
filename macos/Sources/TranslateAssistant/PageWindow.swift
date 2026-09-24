import AppKit
import WebKit

/**
 「在 App 里翻译这个页面」的窗口。

 为什么要有它：让菜单栏 App 自己承担整页双语，就完全不依赖浏览器扩展 ——
 不用上商店、不用用户开任何浏览器开关。App 只向浏览器要一个**地址**
 （见 BrowserTabReader），正文由自己的 WKWebView 重新加载，
 再把 extension/lib/reader.js 打进页面里跑。

 边界要诚实：这是 App 自己的浏览上下文，没有用户在浏览器里的登录态，
 所以登录墙后面的页面、纯前端渲染且需要交互才出内容的页面拿不到正文。
 */
@MainActor
final class PageWindowController: NSObject {

    private let engine: EngineBridge

    private var window: NSWindow?
    private var webView: WKWebView?
    private var urlField: NSTextField?
    private var statusField: NSTextField?
    private var targetPopup: NSPopUpButton?

    /// 译文目标语言。与扩展的「读」模式一致，只有中英两个方向。
    private var target = "zh"
    private var page: ActiveWebPage?

    /// 打包好的注入脚本。读一次留在内存里：每次导航都要重新注一遍。
    private var scriptSource: String?
    private var scriptReadAttempted = false

    /// 引擎里只有一个 Bergamot Transducer，几十个段落并发 await 会让它的
    /// await 点互相踩到，所以原生侧排成一条队。
    private struct Request {
        let id: Int
        let text: String
        let from: String
        let to: String
    }
    private var queue: [Request] = []
    private var draining = false

    init(engine: EngineBridge) {
        self.engine = engine
    }

    // MARK: - 入口

    func present(_ page: ActiveWebPage) {
        ensureWindow()
        self.page = page
        window?.title = "在 App 里翻译 · \(page.title)"
        urlField?.stringValue = page.url.absoluteString
        statusField?.stringValue = "加载页面…"
        installScript()
        webView?.load(URLRequest(url: page.url))
        show()
    }

    /// 读不到地址时的说明。授权没给是这里最需要「点一下就跳过去」的一步。
    func presentError(_ error: BrowserTabReader.ReadError) {
        let alert = NSAlert()
        alert.messageText = "读不到浏览器当前页面"
        alert.informativeText = error.errorDescription ?? "未知原因"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "知道了")
        if error.needsAutomationGrant {
            alert.addButton(withTitle: "打开「自动化」设置")
        }
        show()
        if alert.runModal() == .alertSecondButtonReturn {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")!)
        }
    }

    func shutdown() {
        guard let configuration = webView?.configuration else { return }
        configuration.userContentController.removeScriptMessageHandler(forName: "ltPageTranslate")
        configuration.userContentController.removeScriptMessageHandler(forName: "ltPageState")
        window?.close()
        window = nil
        webView = nil
    }

    private func show() {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    // MARK: - 窗口

    private func ensureWindow() {
        guard window == nil else { return }

        let configuration = WKWebViewConfiguration()
        // 用默认（持久）存储：用户在这个窗口里登录过的站点，下次不用再登一次。
        // 它是 App 自己的浏览上下文，读不到也写不进 Safari/Chrome 的 cookie。
        configuration.websiteDataStore = .default()

        let content = WKWebView(frame: .zero, configuration: configuration)
        content.navigationDelegate = self
        content.allowsBackForwardNavigationGestures = true
        configuration.userContentController.add(self, name: "ltPageTranslate")
        configuration.userContentController.add(self, name: "ltPageState")

        let header = makeHeader()
        header.translatesAutoresizingMaskIntoConstraints = false
        content.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(header)
        container.addSubview(content)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: container.topAnchor),
            header.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: 40),
            content.topAnchor.constraint(equalTo: header.bottomAnchor),
            content.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 720),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "在 App 里翻译"
        window.isReleasedWhenClosed = false
        window.contentView = container
        window.center()
        window.setFrameAutosaveName("TranslateAssistantPageWindow")
        window.delegate = self

        self.window = window
        self.webView = content
    }

    private func makeHeader() -> NSView {
        let bar = NSView()
        bar.wantsLayer = true
        bar.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let url = NSTextField(labelWithString: "")
        url.font = NSFont.systemFont(ofSize: 11)
        url.textColor = NSColor.secondaryLabelColor
        url.lineBreakMode = .byTruncatingMiddle
        url.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        url.setContentHuggingPriority(.init(1), for: .horizontal)

        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.addItems(withTitles: ["译成中文", "译成英文"])
        popup.target = self
        popup.action = #selector(menuTargetChanged)
        popup.setContentHuggingPriority(.required, for: .horizontal)
        self.targetPopup = popup

        let reload = NSButton(title: "重新加载", target: self, action: #selector(menuReload))
        reload.bezelStyle = .rounded
        reload.setContentHuggingPriority(.required, for: .horizontal)

        let status = NSTextField(labelWithString: "")
        status.font = NSFont.systemFont(ofSize: 11)
        status.textColor = NSColor.secondaryLabelColor
        status.toolTip = "整页双语由 App 自己完成：不装扩展、不开浏览器任何开关。\n第一次翻某个语言方向要先下载离线语言包，期间段落会停在「翻译中…」。"
        status.setContentHuggingPriority(.required, for: .horizontal)
        self.statusField = status

        let stack = NSStackView(views: [url, status, reload, popup])
        stack.orientation = .horizontal
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: bar.topAnchor),
            stack.bottomAnchor.constraint(equalTo: bar.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: bar.trailingAnchor)
        ])
        self.urlField = url
        return bar
    }

    // MARK: - 注入脚本

    private func loadScript() -> String? {
        if scriptReadAttempted { return scriptSource }
        scriptReadAttempted = true
        let file = Paths.webRoot.appendingPathComponent("page-bundle.js")
        scriptSource = try? String(contentsOf: file, encoding: .utf8)
        if scriptSource == nil {
            ltTrace("读不到双语脚本：\(file.path)")
        }
        return scriptSource
    }

    private func installScript() {
        guard let webView, let source = loadScript() else {
            statusField?.stringValue = "找不到双语脚本 page-bundle.js，先跑 npm run build:macos"
            return
        }
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        // 配置单独一条 documentStart 脚本：读者在 i18n 之后才读 target，来不及
        controller.addUserScript(WKUserScript(
            source: "window.__ltPageConfig={target:\"\(target)\"};",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
            in: .page
        ))
        controller.addUserScript(WKUserScript(
            source: source,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true,
            in: .page
        ))
    }

    // MARK: - 动作

    @objc private func menuReload() {
        installScript()
        webView?.reload()
    }

    @objc private func menuTargetChanged() {
        target = targetPopup?.indexOfSelectedItem == 1 ? "en" : "zh"
        installScript()
        webView?.reload()
    }

    private func reply(_ result: Result<String, Error>, id: Int) {
        guard let webView else { return }
        switch result {
        case .success(let text):
            webView.callAsyncJavaScript(
                "window.__ltPageResolve?.(id, text)",
                arguments: ["id": id, "text": text],
                in: nil, in: .page
            ) { _ in }
        case .failure(let error):
            webView.callAsyncJavaScript(
                "window.__ltPageReject?.(id, message)",
                arguments: ["id": id, "message": error.localizedDescription],
                in: nil, in: .page
            ) { _ in }
        }
    }

    private func drain() async {
        guard !draining else { return }
        draining = true
        while let request = queue.isEmpty ? nil : queue.removeFirst() {
            do {
                let translated = try await engine.translate(text: request.text, from: request.from, to: request.to)
                reply(.success(translated.text), id: request.id)
            } catch {
                reply(.failure(error), id: request.id)
            }
        }
        draining = false
    }
}

extension PageWindowController: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        queue.removeAll()
        draining = false
    }
}

extension PageWindowController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "ltPageTranslate":
            guard let body = message.body as? [String: Any],
                  let id = body["id"] as? Int,
                  let text = body["text"] as? String,
                  let from = body["from"] as? String,
                  let to = body["to"] as? String else { return }
            queue.append(Request(id: id, text: text, from: from, to: to))
            Task { await drain() }
        case "ltPageState":
            guard let body = message.body as? [String: Any],
                  (body["kind"] as? String) == "ready" else { return }
            statusField?.stringValue = "双语已就绪 · 滚动即逐段翻译"
            probeDiagnostics()
        default:
            break
        }
    }
}

extension PageWindowController {
    /// 「这一页为什么一段都没翻」在调试时得能用数字回答，而不是靠猜。
    /// 只在 `LT_MAC_DEBUG=1` 下跑，正常路径不付这次遍历的开销。
    private func probeDiagnostics() {
        guard LaunchOptions.debug, let webView else { return }
        webView.evaluateJavaScript("""
        JSON.stringify({
          blocks: document.querySelectorAll('p,li,h1,h2,h3,h4,blockquote').length,
          collectable: window.__ltPageReader ? window.__ltPageReader._collectBlocks().length : -1
        })
        """) { value, error in
            let text = value as? String ?? "取诊断失败：\(error?.localizedDescription ?? "")"
            ltTrace("页面诊断：\(text)")
        }
    }
}

extension PageWindowController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        statusField?.stringValue = "加载失败：\(error.localizedDescription)"
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        statusField?.stringValue = "加载失败：\(error.localizedDescription)"
    }
}
