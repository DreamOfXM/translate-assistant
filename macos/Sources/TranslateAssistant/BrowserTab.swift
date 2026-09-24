import AppKit

/// 从浏览器读到的一个标签页。
struct ActiveWebPage {
    let browserName: String
    let url: URL
    let title: String
}

/**
 读取浏览器当前标签页的**地址**。

 这里只用 AppleScript 的只读属性（`URL` / `title`），绝不执行页面里的 JavaScript：
 后者要求用户自己在 Chrome 菜单里勾上「允许来自 Apple 事件的 JavaScript」，
 等于让普通用户为了一个翻译功能主动打开浏览器的自动化口子 —— 不能这么要求。

 代价是只能拿到地址而不是正文，于是正文由 App 自己的 WKWebView 重新加载一遍
 （见 PageWindow）。登录墙后面的页面因此拿不到内容，这是这条路的固有边界。
 */
enum BrowserTabReader {

    enum ReadError: LocalizedError {
        case noBrowser
        case denied(String)
        case empty(String)
        case unsupported(String)
        case failed(browser: String, message: String)

        var errorDescription: String? {
            switch self {
            case .noBrowser:
                return "Chrome / Safari / Edge / Brave 都没在运行。先在浏览器里打开一个网页，再回来点这个菜单。"
            case .denied(let browser):
                return "系统还没允许「翻译助手」读取\(browser)的当前标签页。首次调用会弹一个授权框，点「允许」；"
                    + "没看到弹窗的话去「系统设置 › 隐私与安全性 › 自动化」里勾上。\n"
                    + "（每次重新构建 App 都要重新授权一次，这是系统按签名认应用的规则，不是构建出错。）"
            case .empty(let browser):
                return "\(browser)当前没有可用的窗口或标签页。"
            case .unsupported(let browser):
                return "\(browser)不支持被读取当前标签页。换 Chrome 或 Safari，或直接用浏览器扩展。"
            case .failed(let browser, let message):
                return "读取\(browser)的当前标签页失败：\(message)"
            }
        }

        /// 需要用户去「自动化」面板里动手的错误
        var needsAutomationGrant: Bool {
            if case .denied = self { return true }
            return false
        }
    }

    private struct Browser {
        enum Dialect { case chromium, safari }

        let bundleId: String
        let name: String
        let dialect: Dialect

        /// 两个词法不同的方言：Chromium 系问「front window 的 active tab」，
        /// Safari 问「front document」。取到的都是两个只读文本属性。
        var source: String {
            switch dialect {
            case .chromium:
                return "tell application id \"\(bundleId)\" to get {URL, title} of active tab of front window"
            case .safari:
                return "tell application id \"\(bundleId)\" to get {URL, name} of front document"
            }
        }
    }

    /// 只有真的在运行的才会被问 —— `tell application` 对没启动的 App 会把它拉起来，
    /// 用户只是想翻个页，结果多个浏览器窗口弹出来，那是事故。
    private static let browsers: [Browser] = [
        Browser(bundleId: "com.google.Chrome", name: "Chrome", dialect: .chromium),
        Browser(bundleId: "com.apple.Safari", name: "Safari", dialect: .safari),
        Browser(bundleId: "com.microsoft.edgemac", name: "Edge", dialect: .chromium),
        Browser(bundleId: "com.brave.Browser", name: "Brave", dialect: .chromium),
        Browser(bundleId: "company.thebrowser.Browser", name: "Arc", dialect: .chromium)
    ]

    /// 前台是浏览器就读前台，否则按上面的顺序找第一个在跑的。
    static func readActiveTab() -> Result<ActiveWebPage, ReadError> {
        let running = NSWorkspace.shared.runningApplications.filter { app in
            app.activationPolicy == .regular && browsers.contains { $0.bundleId == (app.bundleIdentifier ?? "") }
        }
        guard !running.isEmpty else { return .failure(.noBrowser) }

        let frontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        // 顺序来源是 browsers：它同时是「前台不是浏览器时」的优先级
        let ordered = browsers.compactMap { browser in running.first { $0.bundleIdentifier == browser.bundleId } }
            .sorted { a, b in
                (a.bundleIdentifier == frontmost ? 0 : 1) < (b.bundleIdentifier == frontmost ? 0 : 1)
            }

        var last: ReadError?
        for application in ordered {
            guard let browser = browsers.first(where: { $0.bundleId == (application.bundleIdentifier ?? "") }) else { continue }
            switch ask(browser) {
            case .success(let page):
                return .success(page)
            case .failure(let error):
                // 权限被拒是最值得先说清的，其它错误只当作「这个浏览器问不到」继续下一个
                if case .denied = error { return .failure(error) }
                last = error
            }
        }
        return .failure(last ?? .noBrowser)
    }

    private static func ask(_ browser: Browser) -> Result<ActiveWebPage, ReadError> {
        var errorInfo: NSDictionary?
        guard let script = NSAppleScript(source: browser.source) else {
            return .failure(.unsupported(browser.name))
        }
        let result = script.executeAndReturnError(&errorInfo)

        if let errorInfo, errorInfo.count > 0 {
            let code = (errorInfo[NSAppleScript.errorNumber] as? Int) ?? 0
            let message = errorInfo[NSAppleScript.errorMessage] as? String
            // -1743  errAEEventNotPermitted：自动化权限没给
            // -1712  超时：多半是授权框弹出来了但没人点
            if code == -1743 || code == -1712 { return .failure(.denied(browser.name)) }
            if code == -1728 || code == -1719 { return .failure(.empty(browser.name)) }
            if code == -1708 { return .failure(.unsupported(browser.name)) }
            return .failure(.failed(browser: browser.name, message: message ?? "系统错误码 \(code)"))
        }

        guard let raw = result.atIndex(1)?.stringValue, let url = URL(string: raw) else {
            return .failure(.empty(browser.name))
        }
        let scheme = (url.scheme ?? "").lowercased()
        guard ["http", "https", "file"].contains(scheme) else {
            // chrome://new-tab-page、Safari 的起始页这类内部页面既没有正文可翻，
            // App 里也重新加载不出来，说清楚比"读不到"有用
            return .failure(.failed(
                browser: browser.name,
                message: "当前标签页是 \(scheme):// 开头的浏览器内部页面，不是普通网页"
            ))
        }

        return .success(ActiveWebPage(
            browserName: browser.name,
            url: url,
            title: result.atIndex(2)?.stringValue ?? url.host ?? url.absoluteString
        ))
    }
}
