import CryptoKit
import Foundation
import Network

/**
 回环 HTTP 服务：给 WKWebView 里的翻译引擎当宿主。

 为什么要它，而不是直接 loadFileURL 加载本地页面：
 1. 引擎必须跑在 Web Worker 里，而 file:// 页面创建 Worker 会被 WebKit 拒绝，
    必须有一个真正的 http 源；http://127.0.0.1 同时满足「安全上下文」条件。
 2. 语言包要挂在 storage.googleapis.com 上，网页里直接 fetch 会被 CORS 拦住。
    由原生侧代下载再吐回给页面，CORS 问题不存在。
 3. 语言包落盘就地实现，和扩展那边用 Cache Storage 是同一套「缓存 / 校验」语义。

 路由：
   GET  /                  → web/engine.html
   GET  /<path>            → web/ 下的静态文件（.wasm 必须是 application/wasm）
   GET  /proxy?u=<url>     → 代下载 storage.googleapis.com，边下边吐（进度可视）
   GET  /cache/get?c=&k=   → 取语言包缓存
   PUT  /cache/put?c=&k=   → 存语言包缓存
   DELETE /cache/entry?c=&k=
   DELETE /cache/all?c=
   GET  /health            → 存活探测
 */
final class EngineServer {

    enum ServerError: LocalizedError {
        case start(String)

        var errorDescription: String? {
            switch self {
            case .start(let detail): return "引擎服务启动失败：\(detail)"
            }
        }
    }

    private let queue = DispatchQueue(label: "translate-assistant.engine-server")
    private let webRoot: URL
    private let cacheRoot: URL

    private var listener: NWListener?
    private var connections: [ObjectIdentifier: HTTPConnection] = [:]

    private(set) var port: UInt16 = 0
    private(set) var lastError: String?

    /// 打开后把所有请求和上游状态打到 stderr，排查引擎问题用
    var verbose = ProcessInfo.processInfo.environment["LT_MAC_DEBUG"] != nil

    init(webRoot: URL, cacheRoot: URL) {
        self.webRoot = webRoot
        self.cacheRoot = cacheRoot
        try? FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    // MARK: - 生命周期

    func start(preferredPort: UInt16 = 0) throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        // 只监听回环，不对外暴露
        parameters.requiredInterfaceType = .loopback

        let endpoint: NWEndpoint.Port = preferredPort == 0 ? .any : (NWEndpoint.Port(rawValue: preferredPort) ?? .any)

        let listener: NWListener
        do {
            listener = try NWListener(using: parameters, on: endpoint)
        } catch {
            throw ServerError.start(error.localizedDescription)
        }

        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.port = listener.port?.rawValue ?? 0
                ready.signal()
            case .failed(let error):
                self?.lastError = error.localizedDescription
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)

        if ready.wait(timeout: .now() + 10) == .timedOut {
            listener.cancel()
            throw ServerError.start("监听超时")
        }
        if let error = lastError {
            listener.cancel()
            throw ServerError.start(error)
        }
        guard port != 0 else {
            listener.cancel()
            throw ServerError.start("拿不到端口号")
        }

        self.listener = listener
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.listener?.cancel()
            self.listener = nil
            for connection in self.connections.values { connection.cancel() }
            self.connections.removeAll()
        }
    }

    private func accept(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        let handler = HTTPConnection(connection: connection, queue: queue) { [weak self] request, responder in
            self?.route(request, responder)
        } onClose: { [weak self] in
            self?.queue.async { self?.connections.removeValue(forKey: id) }
        }
        connections[id] = handler
        handler.start()
    }

    // MARK: - 路由

    private func route(_ request: HTTPRequest, _ responder: HTTPResponder) {
        log("\(request.method) \(request.path)\(request.query.isEmpty ? "" : "?…")")

        switch (request.method, request.path) {
        case ("GET", "/health"):
            responder.json(["ok": true, "port": Int(port)])

        case ("GET", "/proxy"):
            guard let raw = request.query["u"], let url = URL(string: raw) else {
                responder.fail("缺少 u 参数", status: 400)
                return
            }
            guard url.host == "storage.googleapis.com" else {
                responder.fail("只允许代理语言包来源", status: 403)
                return
            }
            proxy(url, responder)

        case ("GET", "/cache/get"):
            cacheGet(request, responder)

        case ("PUT", "/cache/put"):
            cachePut(request, responder)

        case ("DELETE", "/cache/entry"):
            cacheDeleteEntry(request, responder)

        case ("DELETE", "/cache/all"):
            cacheDeleteAll(request, responder)

        case ("GET", let path):
            serveStatic(path, head: false, responder)

        case ("HEAD", let path):
            serveStatic(path, head: true, responder)

        default:
            responder.fail("不支持的方法 \(request.method)", status: 405)
        }
    }

    // MARK: - 静态资源

    private func serveStatic(_ path: String, head: Bool, _ responder: HTTPResponder) {
        var relative = path == "/" ? "engine.html" : String(path.dropFirst())
        relative = relative.removingPercentEncoding ?? relative

        // 目录穿越保护：任何解析后逃出 webRoot 的路径都拒掉
        let candidate = webRoot.appendingPathComponent(relative).standardizedFileURL
        guard candidate.path.hasPrefix(webRoot.standardizedFileURL.path) else {
            responder.fail("非法路径", status: 403)
            return
        }

        guard let data = try? Data(contentsOf: candidate, options: .mappedIfSafe) else {
            responder.fail("找不到 \(relative)", status: 404)
            return
        }

        responder.respond(
            status: 200,
            headers: ["Content-Type": Mime.type(of: candidate.pathExtension)],
            body: head ? Data() : data,
            declaredLength: data.count
        )
    }

    // MARK: - 语言包代理

    /// 原生侧代下：网页里 fetch storage.googleapis.com 会被 CORS 挡，
    /// 这里用 URLSession 下完直接吐回给同源的页面。
    ///
    /// 显式要求 `Accept-Encoding: identity`，否则 URLSession 会自动解压而
    /// Content-Length 仍是压缩前的值，页面上的进度条会算错。
    private func proxy(_ url: URL, _ responder: HTTPResponder) {
        let task = ProxyTask(
            url: url,
            onResponse: { [weak self] response in
                let length = response.expectedContentLength > 0 ? Int(response.expectedContentLength) : nil
                self?.log("上游 \(response.statusCode) \(length.map { "\($0) 字节" } ?? "长度未知")")
                return responder.beginStream(
                    status: response.statusCode,
                    headers: ["Content-Type": response.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"],
                    length: length
                )
            },
            onError: { [weak self] error in
                self?.log("代理失败：\(error.localizedDescription)")
                responder.fail("语言包下载失败：\(error.localizedDescription)", status: 502)
            }
        )
        task.start()
    }

    private func log(_ message: String) {
        guard verbose else { return }
        FileHandle.standardError.write(Data("[engine] \(message)\n".utf8))
    }

    // MARK: - 语言包缓存

    private func cacheGet(_ request: HTTPRequest, _ responder: HTTPResponder) {
        guard let file = cacheFile(request) else {
            responder.fail("缺少 c / k 参数", status: 400)
            return
        }
        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            responder.fail("缓存未命中", status: 404)
            return
        }
        responder.respond(status: 200, headers: ["Content-Type": "application/octet-stream"], body: data)
    }

    private func cachePut(_ request: HTTPRequest, _ responder: HTTPResponder) {
        guard let file = cacheFile(request) else {
            responder.fail("缺少 c / k 参数", status: 400)
            return
        }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try request.body.write(to: file, options: .atomic)
            responder.respond(status: 204, headers: [:], body: Data())
        } catch {
            responder.fail("缓存写入失败：\(error.localizedDescription)", status: 500)
        }
    }

    private func cacheDeleteEntry(_ request: HTTPRequest, _ responder: HTTPResponder) {
        guard let file = cacheFile(request) else {
            responder.fail("缺少 c / k 参数", status: 400)
            return
        }
        try? FileManager.default.removeItem(at: file)
        responder.respond(status: 204, headers: [:], body: Data())
    }

    private func cacheDeleteAll(_ request: HTTPRequest, _ responder: HTTPResponder) {
        guard let name = request.query["c"] else {
            responder.fail("缺少 c 参数", status: 400)
            return
        }
        try? FileManager.default.removeItem(at: cacheRoot.appendingPathComponent(sanitize(name)))
        responder.respond(status: 204, headers: [:], body: Data())
    }

    /// 一个语言包 = 一个文件。文件名用 cache+key 的 sha256，避免 URL 里的
    /// 斜杠和长度把文件系统搞崩，也顺手把「哪个方向」编进目录名方便用户手动清。
    private func cacheFile(_ request: HTTPRequest) -> URL? {
        guard let name = request.query["c"], let key = request.query["k"] else { return nil }
        let digest = SHA256.hash(data: Data((name + "\u{1}" + key).utf8))
        let filename = digest.map { String(format: "%02x", $0) }.joined()
        return cacheRoot.appendingPathComponent(sanitize(name)).appendingPathComponent(filename)
    }

    private func sanitize(_ name: String) -> String {
        name.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." ? $0 : "_" }.reduce(into: "") { $0.append($1) }
    }
}

// MARK: - 代理任务

/// URLSession 的 data delegate 才是真正的「边下边给」，用 async/await 的
/// `bytes(for:)` 只能逐字节迭代，30MB 的语言包会慢到不可用。
private final class ProxyTask: NSObject, URLSessionDataDelegate {

    private let url: URL
    private let onResponse: (HTTPURLResponse) -> ((Data?) -> Void)?
    private let onError: (Error) -> Void

    private var session: URLSession?
    private var write: ((Data?) -> Void)?
    private var finished = false

    init(url: URL,
         onResponse: @escaping (HTTPURLResponse) -> ((Data?) -> Void)?,
         onError: @escaping (Error) -> Void) {
        self.url = url
        self.onResponse = onResponse
        self.onError = onError
    }

    func start() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session

        var request = URLRequest(url: url)
        // 见 EngineServer.proxy 的说明：不让 URLSession 自动解压，长度才对得上
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.timeoutInterval = 120
        session.dataTask(with: request).resume()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            onError(URLError(.badServerResponse))
            return
        }
        write = onResponse(http)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        write?(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        finished = true
        session.invalidateAndCancel()

        if let error, write == nil {
            // 还没开始吐就给上游报错，页面能看到原因
            onError(error)
            return
        }
        // 已经开始吐了就只能收尾：头部声明的长度可能没凑满，连接关掉让页面自己判
        write?(nil)
    }
}

// MARK: - MIME

enum Mime {
    static func type(of pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        // 必须是 application/wasm，否则 WebAssembly.instantiateStreaming 会拒绝
        case "wasm": return "application/wasm"
        case "json": return "application/json; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }
}
