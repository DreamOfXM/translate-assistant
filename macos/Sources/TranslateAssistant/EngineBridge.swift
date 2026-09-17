import AppKit
import WebKit

/**
 引擎桥：把 WKWebView 里跑的 Bergamot WASM 引擎包成 Swift 的 async 接口。

 WebView 需要一个窗口才不会被 WebKit 降频，但它绝不能抢走目标 App 的焦点
 —— 焦点一丢，回填就写不回原来的输入框了。所以用离屏 + 不能成为 key 的窗口。
 */
@MainActor
final class EngineBridge: NSObject {

    struct Translation {
        let text: String
        let source: String
        let target: String
    }

    struct Progress {
        let phase: String
        let percent: Int
        let label: String

        var isDownloading: Bool { phase == "downloading" }
    }

    enum BridgeError: LocalizedError {
        case pageNotReady
        case navigationFailed(String)
        case javascript(String)

        var errorDescription: String? {
            switch self {
            case .pageNotReady: return "翻译引擎页面没有就绪"
            case .navigationFailed(let detail): return "引擎页面加载失败：\(detail)"
            case .javascript(let message): return message
            }
        }
    }

    private let webView: WKWebView
    private let window: HostWindow
    private var navigationError: String?

    /// 语言包下载/加载进度。会从 WebKit 的消息回调线程切回主线程再触发。
    var onProgress: ((Progress) -> Void)?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.suppressesIncrementalRendering = true

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 600), configuration: configuration)
        window = HostWindow(
            contentRect: NSRect(x: -4000, y: -4000, width: 900, height: 600),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )

        super.init()

        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.hasShadow = false

        // 进度回调：页面里 window.ltOnProgress 会 postMessage 到这个名字
        configuration.userContentController.add(self, name: "ltProgress")
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.ltOnProgress = (p) => { try { window.webkit.messageHandlers.ltProgress.postMessage(p); } catch (e) {} };",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
            in: .page
        ))

        webView.navigationDelegate = self
    }

    deinit {
        // 不动 userContentController：它被 @MainActor 隔离，在 deinit 里访问
        // 既编不过也不安全。改由 shutdown() 显式解绑，见 AppDelegate 的退出流程。
    }

    /// 解绑消息处理器。userContentController 会强引用 handler，不解绑就是循环引用。
    func shutdown() {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "ltProgress")
        onProgress = nil
    }

    // MARK: - 生命周期

    /// 加载引擎页面。窗口只 orderBack 不 orderFront —— 它只要「存在」，
    /// 不需要可见，更不需要抢焦点。
    func start(baseURL: URL) {
        window.orderBack(nil)
        webView.load(URLRequest(url: baseURL))
    }

    private func waitUntilReady(timeout: TimeInterval = 20) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let error = navigationError { throw BridgeError.navigationFailed(error) }
            if let ready = try? await webView.evaluateJavaScript("window.__ltEngineReady === true") as? Bool, ready {
                return
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        throw BridgeError.pageNotReady
    }

    // MARK: - 翻译

    func translate(text: String, from: String, to: String) async throws -> Translation {
        try await waitUntilReady()
        let result = try await call("""
        const r = await window.ltEngine.translate(text, from, to);
        return { text: r.text, source: r.source, target: r.target };
        """, arguments: ["text": text, "from": from, "to": to])

        guard let dictionary = result as? [String: Any] else { throw BridgeError.javascript("译文格式异常") }
        return Translation(
            text: dictionary["text"] as? String ?? "",
            source: dictionary["source"] as? String ?? from,
            target: dictionary["target"] as? String ?? to
        )
    }

    /// 预下载某个方向的语言包（方向写法 `en-zh`）
    @discardableResult
    func preload(direction: String) async throws -> Int {
        try await waitUntilReady()
        let result = try await call("return await window.ltEngine.preload(direction);", arguments: ["direction": direction])
        guard let dictionary = result as? [String: Any] else { return 0 }
        return (dictionary["packs"] as? [Any])?.count ?? 0
    }

    /// 语言包目录，用于展示「哪些方向可用」
    func catalog() async throws -> [[String: Any]] {
        try await waitUntilReady()
        let result = try await call("return await window.ltEngine.catalog();")
        return result as? [[String: Any]] ?? []
    }

    func detect(_ text: String) async throws -> String {
        try await waitUntilReady()
        let result = try await call("return window.ltEngine.detect(text);", arguments: ["text": text])
        return result as? String ?? "en"
    }

    // MARK: - JS 调用

    private func call(_ body: String, arguments: [String: Any] = [:]) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { result in
                switch result {
                case .success(let value): continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: EngineBridge.javascriptError(error))
                }
            }
        }
    }

    /// JS 抛出来的异常在 NSError 里包了两层，剥出人能看懂的那句
    private static func javascriptError(_ error: Error) -> Error {
        let nsError = error as NSError
        let message = nsError.userInfo["WKJavaScriptExceptionMessage"] as? String
            ?? nsError.userInfo[NSLocalizedDescriptionKey] as? String
            ?? nsError.localizedDescription
        return BridgeError.javascript(message)
    }

    /// 不能成为 key/main window：一旦成为，目标 App 就失去焦点，回填会失败
    private final class HostWindow: NSWindow {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }
}

extension EngineBridge: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationError = error.localizedDescription
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationError = error.localizedDescription
    }
}

extension EngineBridge: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "ltProgress", let body = message.body as? [String: Any] else { return }
        let progress = Progress(
            phase: body["phase"] as? String ?? "",
            percent: body["percent"] as? Int ?? 0,
            label: body["label"] as? String ?? ""
        )
        Task { @MainActor in onProgress?(progress) }
    }
}
