import Foundation

/// One Server-Sent Event.
struct SSEEvent: Sendable {
    var event: String
    var data: String
    var id: String?

    /// Synthetic event emitted once the HTTP response is accepted.
    static let openEvent = "__open"
}

/// Minimal, spec-following Server-Sent Events client built on `URLSession.bytes(for:)`.
///
/// `connect()` opens a single connection and yields events until the stream ends or fails.
/// Reconnection with backoff is handled by `SSEConnection` below.
///
/// Note: `AsyncBytes.lines` drops empty lines, but SSE uses blank lines as event
/// terminators, so we split bytes ourselves.
struct SSEClient: Sendable {
    let url: URL
    var session: URLSession = SSEClient.makeSession()

    static func makeSession() -> URLSession {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 75 // server sends `: ping` every 20s
        cfg.timeoutIntervalForResource = 60 * 60 * 24
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }

    func connect(lastEventId: String? = nil) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: url)
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                    if let lastEventId { req.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID") }
                    let (bytes, resp) = try await session.bytes(for: req)
                    if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
                        throw APIError.http(http.statusCode, nil)
                    }
                    continuation.yield(SSEEvent(event: SSEEvent.openEvent, data: ""))
                    var parser = SSEParser()
                    var line: [UInt8] = []
                    line.reserveCapacity(1024)
                    var lastWasCR = false
                    for try await byte in bytes {
                        if byte == 0x0A, lastWasCR { lastWasCR = false; continue } // CRLF
                        lastWasCR = byte == 0x0D
                        if byte == 0x0A || byte == 0x0D {
                            if let ev = parser.consume(line: String(decoding: line, as: UTF8.self)) {
                                continuation.yield(ev)
                            }
                            line.removeAll(keepingCapacity: true)
                        } else {
                            line.append(byte)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Line-oriented SSE parser (https://html.spec.whatwg.org/multipage/server-sent-events.html).
struct SSEParser: Sendable {
    private var event = ""
    private var data: [String] = []
    private(set) var lastId: String?

    mutating func consume(line: String) -> SSEEvent? {
        if line.isEmpty {
            defer { event = ""; data = [] }
            guard !data.isEmpty else { return nil }
            return SSEEvent(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"), id: lastId)
        }
        if line.hasPrefix(":") { return nil } // comment / ping
        let field: Substring, value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            var v = line[line.index(after: colon)...]
            if v.hasPrefix(" ") { v = v.dropFirst() }
            value = v
        } else {
            field = Substring(line); value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        case "id": lastId = String(value)
        default: break // `retry` handled by our own backoff
        }
        return nil
    }
}

enum ConnectionState: Equatable, Sendable {
    case idle, connecting, live, reconnecting(in: Int), failed(String)

    var label: String {
        switch self {
        case .idle: "Offline"
        case .connecting: "Connecting"
        case .live: "Live"
        case .reconnecting(let s): "Retry \(s)s"
        case .failed: "Offline"
        }
    }
    var isLive: Bool { self == .live }
}

/// Keeps an SSE connection alive with exponential backoff (1s → 30s, jittered).
@MainActor
final class SSEConnection {
    private var task: Task<Void, Never>?
    var onEvent: (SSEEvent) -> Void = { _ in }
    var onState: (ConnectionState) -> Void = { _ in }

    func start(url: URL) {
        stop()
        task = Task { [weak self] in
            var backoff: Double = 1
            var lastId: String?
            while !Task.isCancelled {
                self?.onState(.connecting)
                do {
                    let stream = SSEClient(url: url).connect(lastEventId: lastId)
                    for try await ev in stream {
                        if ev.event == SSEEvent.openEvent { backoff = 1; self?.onState(.live); continue }
                        if let id = ev.id { lastId = id }
                        self?.onEvent(ev)
                    }
                } catch is CancellationError {
                    return
                } catch {
                    if Task.isCancelled { return }
                }
                if Task.isCancelled { return }
                let wait = min(backoff, 30) * Double.random(in: 0.8...1.2)
                self?.onState(.reconnecting(in: Int(wait.rounded(.up))))
                try? await Task.sleep(for: .seconds(wait))
                backoff = min(backoff * 2, 30)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}
