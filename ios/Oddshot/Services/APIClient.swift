import Foundation

enum APIError: LocalizedError {
    case badURL
    case http(Int, String?)
    case decoding(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .badURL: "The server URL is invalid. Check Settings."
        case .http(let code, let msg): "Server returned \(code)\(msg.map { ": \($0)" } ?? "")"
        case .decoding(let m): "Unexpected response from server (\(m))."
        case .transport(let m): m
        }
    }
}

enum ServerConfig {
    static let defaultURL = "http://localhost:8787"
    static let key = "serverURL"

    static var current: String {
        let s = UserDefaults.standard.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return s.isEmpty ? defaultURL : s
    }

    static func url(from string: String) -> URL? {
        var s = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s), u.host() != nil else { return nil }
        return u
    }
}

/// Thin async/await client for the Oddshot REST API (see CONTRACT.md).
struct APIClient: Sendable {
    let baseURL: URL
    var session: URLSession = .shared

    static var current: APIClient? {
        ServerConfig.url(from: ServerConfig.current).map { APIClient(baseURL: $0) }
    }

    func url(_ path: String, query: [String: String] = [:]) -> URL {
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comps.percentEncodedPath = (comps.percentEncodedPath.hasSuffix("/") ? String(comps.percentEncodedPath.dropLast()) : comps.percentEncodedPath) + path
        let items = query.filter { !$0.value.isEmpty }.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        if !items.isEmpty { comps.queryItems = items }
        return comps.url!
    }

    private func send<T: Decodable>(_ method: String, _ path: String, query: [String: String] = [:],
                                    body: Data? = nil, timeout: TimeInterval = 12) async throws -> T {
        var req = URLRequest(url: url(path, query: query), timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data, resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch let e as URLError {
            switch e.code {
            case .cannotConnectToHost, .cannotFindHost, .timedOut, .networkConnectionLost, .notConnectedToInternet:
                throw APIError.transport("Can’t reach the Oddshot server at \(baseURL.absoluteString). Is it running?")
            default:
                throw APIError.transport(e.localizedDescription)
            }
        }
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.http(http.statusCode, (try? JSONDecoder().decode(ServerError.self, from: data))?.error)
        }
        if T.self == Empty.self, let empty = Empty() as? T { return empty }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error).prefix(140).description)
        }
    }

    struct Empty: Decodable, Sendable {}
    struct ServerError: Decodable, Sendable { let error: String? }

    // MARK: Endpoints

    func health() async throws -> Health { try await send("GET", "/api/health", timeout: 6) }

    func markets(q: String = "", category: String = "", source: String = "", limit: Int = 50) async throws -> [Market] {
        try await send("GET", "/api/markets", query: ["q": q, "category": category, "source": source, "limit": "\(limit)"])
    }

    func history(marketId: String) async throws -> [PricePoint] {
        let h: MarketHistory = try await send("GET", "/api/markets/\(encodedId(marketId))/history")
        return h.points.sorted { $0.t < $1.t }
    }

    func movers(limit: Int = 30) async throws -> [Mover] {
        try await send("GET", "/api/movers", query: ["limit": "\(limit)"])
    }

    func vix() async throws -> VolatilityIndex { try await send("GET", "/api/vix") }

    func alerts(limit: Int = 100) async throws -> [Spike] {
        try await send("GET", "/api/alerts", query: ["limit": "\(limit)"])
    }

    func subscriptions() async throws -> [Subscription] { try await send("GET", "/api/subscriptions") }

    func create(_ sub: Subscription) async throws -> Subscription {
        try await send("POST", "/api/subscriptions", body: try JSONEncoder().encode(sub))
    }

    func update(_ sub: Subscription) async throws -> Subscription {
        try await send("PUT", "/api/subscriptions/\(sub.id)", body: try JSONEncoder().encode(sub))
    }

    func delete(subscriptionId: String) async throws {
        let _: Empty = try await send("DELETE", "/api/subscriptions/\(subscriptionId)")
    }

    func test(subscriptionId: String) async throws -> TestResult {
        try await send("POST", "/api/subscriptions/\(subscriptionId)/test", body: Data("{}".utf8))
    }

    // MARK: v2 (Shot List & Insights). These may 404 while the backend catches up; callers degrade gracefully.

    private func encodedId(_ marketId: String) -> String {
        marketId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? marketId
    }

    func shots(persona: Persona, category: String = "", limit: Int = 20) async throws -> [Shot] {
        let r: LenientList<Shot> = try await send("GET", "/api/shots",
            query: ["persona": persona.rawValue, "category": category, "limit": "\(limit)"])
        return r.items
    }

    func insights(limit: Int = 50) async throws -> [Insight] {
        let r: LenientList<Insight> = try await send("GET", "/api/insights", query: ["limit": "\(limit)"])
        return r.items
    }

    func stories() async throws -> [Story] {
        let r: LenientList<Story> = try await send("GET", "/api/stories")
        return r.items
    }

    func briefing() async throws -> Briefing { try await send("GET", "/api/briefing") }

    func forecast(marketId: String) async throws -> Forecast {
        try await send("GET", "/api/markets/\(encodedId(marketId))/forecast")
    }

    // v3
    func context(marketId: String) async throws -> LiveContext {
        try await send("GET", "/api/markets/\(encodedId(marketId))/context")
    }

    func recommendation(marketId: String, role: Persona) async throws -> Recommendation {
        try await send("GET", "/api/markets/\(encodedId(marketId))/recommendation", query: ["role": role.rawValue], timeout: 25)
    }

    func simulateSpike(marketId: String? = nil) async throws -> Spike {
        let body = marketId.map { try? JSONEncoder().encode(["marketId": $0]) } ?? Data("{}".utf8)
        return try await send("POST", "/api/demo/spike", body: body ?? Data("{}".utf8))
    }
}

extension Error {
    /// True when the server is reachable but doesn't (yet) implement the route.
    var isNotFound: Bool {
        if let e = self as? APIError, case .http(let code, _) = e { return code == 404 }
        return false
    }
}
