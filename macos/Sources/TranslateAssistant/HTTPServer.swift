import Foundation
import Network

/**
 极简 HTTP/1.1 传输层：只服务回环上的翻译引擎页面，够用就行。

 有意做的取舍：
 - 不做 keep-alive，每个响应都带 `Connection: close`，发完就关连接。
   请求量本来就是个位数，省掉连接复用的状态机。
 - 不做 chunked 请求体；PUT 的 Content-Length 我们要求必须有。
 - 流式响应在拿不到上游长度时不写 Content-Length，靠关闭连接界定结束
   （HTTP/1.1 允许，且我们本来就发 Connection: close）。
 */

struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let headers: [String: String]
    let body: Data

    var description: String { "\(method) \(path)" }
}

final class HTTPResponder {

    private let connection: NWConnection
    private let queue: DispatchQueue
    private var started = false

    init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
    }

    func respond(status: Int, headers: [String: String] = [:], body: Data, declaredLength: Int? = nil) {
        guard !started else { return }
        started = true
        let head = HTTPMessage.head(status: status, headers: headers, length: declaredLength ?? body.count)
        var payload = head
        payload.append(body)
        connection.send(content: payload, isComplete: true, completion: .contentProcessed { [connection] _ in
            connection.cancel()
        })
    }

    func json(_ object: [String: Any], status: Int = 200) {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        respond(status: status, headers: ["Content-Type": "application/json; charset=utf-8"], body: data)
    }

    func fail(_ message: String, status: Int = 500) {
        let body = Data((message + "\n").utf8)
        respond(status: status, headers: ["Content-Type": "text/plain; charset=utf-8"], body: body)
    }

    /// 开始一个流式响应。返回的闭包喂数据，传 nil 表示结束。
    /// 语言包有几十 MB，必须边下边吐，否则页面上的进度条只能一跳到底。
    func beginStream(status: Int, headers: [String: String], length: Int?) -> (Data?) -> Void {
        started = true
        let head = HTTPMessage.head(status: status, headers: headers, length: length)
        connection.send(content: head, completion: .contentProcessed { _ in })

        let stream = StreamState()
        return { [weak self] chunk in
            guard let self, !stream.finished else { return }
            if let chunk {
                self.connection.send(content: chunk, completion: .contentProcessed { _ in })
            } else {
                stream.finished = true
                self.connection.send(content: nil, isComplete: true, completion: .contentProcessed { [weak connection = self.connection] _ in
                    connection?.cancel()
                })
            }
        }
    }

    private final class StreamState { var finished = false }
}

final class HTTPConnection {

    private let connection: NWConnection
    private let queue: DispatchQueue
    private let onRequest: (HTTPRequest, HTTPResponder) -> Void
    private let onClose: () -> Void

    private var buffer = Data()
    private var pendingBody: Int?
    private var head: (method: String, path: String, query: [String: String], headers: [String: String])?
    private var closed = false

    /// 请求体上限，挡住畸形请求把内存撑爆
    private let bodyLimit = 512 * 1024 * 1024

    init(connection: NWConnection,
         queue: DispatchQueue,
         onRequest: @escaping (HTTPRequest, HTTPResponder) -> Void,
         onClose: @escaping () -> Void) {
        self.connection = connection
        self.queue = queue
        self.onRequest = onRequest
        self.onClose = onClose
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.finish()
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive()
    }

    func cancel() {
        connection.cancel()
        finish()
    }

    private func finish() {
        guard !closed else { return }
        closed = true
        onClose()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self, !self.closed else { return }

            if let data, !data.isEmpty {
                self.buffer.append(data)
                if self.consume() { return }
            }

            if isComplete || error != nil {
                self.finish()
                return
            }
            self.receive()
        }
    }

    /// 返回 true 表示已经响应完毕、不用再收了
    private func consume() -> Bool {
        if head == nil {
            guard let separator = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                return false
            }
            let headData = buffer[buffer.startIndex..<separator.lowerBound]
            buffer.removeSubrange(buffer.startIndex..<separator.upperBound)

            guard let parsed = HTTPMessage.parseHead(headData) else {
                HTTPResponder(connection: connection, queue: queue).fail("请求格式错误", status: 400)
                return true
            }
            head = parsed
            pendingBody = Int(parsed.headers["content-length"] ?? "0") ?? 0

            guard (pendingBody ?? 0) <= bodyLimit else {
                HTTPResponder(connection: connection, queue: queue).fail("请求体过大", status: 413)
                return true
            }
        }

        guard let head, let remaining = pendingBody else { return false }
        guard buffer.count >= remaining else { return false }

        let body = Data(buffer.prefix(remaining))
        buffer.removeAll(keepingCapacity: false)
        pendingBody = nil

        let request = HTTPRequest(method: head.method, path: head.path, query: head.query, headers: head.headers, body: body)
        onRequest(request, HTTPResponder(connection: connection, queue: queue))
        return true
    }
}

enum HTTPMessage {

    static func parseHead(_ data: Data) -> (method: String, path: String, query: [String: String], headers: [String: String])? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        var lines = text.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }

        let requestLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
        guard requestLine.count >= 2 else { return nil }
        let method = String(requestLine[0]).uppercased()
        let target = String(requestLine[1])

        var headers: [String: String] = [:]
        for line in lines where !line.isEmpty {
            guard let separator = line.firstIndex(of: ":") else { continue }
            let key = line[line.startIndex..<separator].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        let parts = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = String(parts.first ?? "/")
        let query = parts.count > 1 ? parseQuery(String(parts[1])) : [:]
        return (method, path, query, headers)
    }

    private static func parseQuery(_ raw: String) -> [String: String] {
        var result: [String: String] = [:]
        for pair in raw.split(separator: "&") where !pair.isEmpty {
            let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let rawKey = kv.first else { continue }
            let rawValue = kv.count > 1 ? String(kv[1]) : ""
            let key = String(rawKey).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String(rawKey)
            let value = rawValue.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? rawValue
            result[key] = value
        }
        return result
    }

    static func head(status: Int, headers: [String: String], length: Int?) -> Data {
        var merged = headers
        // 页面和本服务同源，不需要 CORS 头；关掉缓存免得改代码后拿到旧文件
        merged["Connection"] = "close"
        merged["Cache-Control"] = "no-store"
        if let length { merged["Content-Length"] = String(length) }

        var lines = ["HTTP/1.1 \(status) \(reason(status))"]
        for (key, value) in merged.sorted(by: { $0.key < $1.key }) {
            lines.append("\(key): \(value)")
        }
        return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 413: return "Payload Too Large"
        case 502: return "Bad Gateway"
        case 500: return "Internal Server Error"
        default: return "Status"
        }
    }
}
