import Foundation
import Security

/// What people on X are saying about a market right now.
struct XPulse: Sendable, Hashable {
    struct Post: Sendable, Hashable, Identifiable {
        var id: String
        var text: String
        var author: String
        var date: Date
    }
    var query: String
    var posts: [Post]           // newest first
    var perMinute: Double       // posts per minute over the last 5 minutes
    var surge: Double           // last 5 min vs the rest of the sample (1 = normal)
    var fetchedAt: Date

    /// Chatter is suddenly much louder than it was: something may be happening.
    var isSpiking: Bool { surge >= 2.5 && perMinute >= 2 }
}

/// Optional X (Twitter) integration. Uses the official API v2 recent search with the user's
/// own bearer token (developer.x.com). The token stays in the iPhone Keychain and is only
/// sent to api.x.com.
enum XFeed {
    enum Failure: Error { case noToken, unauthorized, rateLimited, http(Int), network }

    static func search(_ query: String) async throws -> XPulse {
        guard let token = Keychain.read("xBearerToken"), !token.isEmpty else { throw Failure.noToken }
        var c = URLComponents(string: "https://api.x.com/2/tweets/search/recent")!
        c.queryItems = [
            .init(name: "query", value: query),
            .init(name: "max_results", value: "50"),
            .init(name: "tweet.fields", value: "created_at"),
            .init(name: "expansions", value: "author_id"),
            .init(name: "user.fields", value: "username"),
        ]
        var req = URLRequest(url: c.url!, timeoutInterval: 12)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, resp) = try? await URLSession.shared.data(for: req) else { throw Failure.network }
        switch (resp as? HTTPURLResponse)?.statusCode ?? 0 {
        case 200: break
        case 401, 403: throw Failure.unauthorized
        case 429: throw Failure.rateLimited
        case let code: throw Failure.http(code)
        }
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let users = ((obj["includes"] as? [String: Any])?["users"] as? [[String: Any]] ?? [])
            .reduce(into: [String: String]()) { $0[$1["id"] as? String ?? ""] = $1["username"] as? String }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let posts: [XPulse.Post] = (obj["data"] as? [[String: Any]] ?? []).compactMap { t in
            guard let id = t["id"] as? String, let text = t["text"] as? String,
                  let date = (t["created_at"] as? String).flatMap(iso.date(from:)) else { return nil }
            return .init(id: id, text: text, author: users[t["author_id"] as? String ?? ""] ?? "someone", date: date)
        }.sorted { $0.date > $1.date }

        let now = Date()
        let recent = posts.filter { now.timeIntervalSince($0.date) <= 300 }.count
        let perMinute = Double(recent) / 5
        var surge = 1.0
        if let oldest = posts.last, posts.count > recent {
            let olderMinutes = max(now.timeIntervalSince(oldest.date) / 60 - 5, 1)
            let olderRate = Double(posts.count - recent) / olderMinutes
            surge = olderRate > 0 ? perMinute / olderRate : (recent > 5 ? 3 : 1)
        }
        return XPulse(query: query, posts: posts, perMinute: perMinute, surge: surge, fetchedAt: now)
    }

    /// "Avalanche vs. Flyers" → ("Avalanche" OR "Flyers"); otherwise the key words of the question.
    static func query(for m: Market) -> String {
        var t = m.eventTitle ?? m.title
        if let colon = t.firstIndex(of: ":"), t.distance(from: t.startIndex, to: colon) < 25 { t = String(t[t.index(after: colon)...]) }
        let sides = t.replacingOccurrences(of: " vs. ", with: "|").replacingOccurrences(of: " vs ", with: "|").split(separator: "|")
        let terms: [String]
        if sides.count == 2 {
            terms = sides.map { $0.split(separator: "(")[0].split(separator: "-")[0].trimmingCharacters(in: .whitespaces) }
        } else {
            let stop: Set<String> = ["will", "the", "a", "an", "of", "in", "on", "by", "be", "to", "for", "and", "or", "win", "what", "who", "how", "much", "2026", "2027", "2028"]
            let words = t.replacingOccurrences(of: "?", with: "").split(separator: " ").map(String.init)
                .filter { !stop.contains($0.lowercased()) && $0.count > 2 }
            terms = [words.prefix(3).joined(separator: " ")]
        }
        let body = terms.filter { !$0.isEmpty }.map { "\"\($0)\"" }.joined(separator: " OR ")
        return "(\(body)) -is:retweet lang:en"
    }
}

/// Minimal Keychain wrapper for the X token.
enum Keychain {
    private static func base(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.tipoff", kSecAttrAccount as String: key]
    }

    static func read(_ key: String) -> String? {
        var q = base(key)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func write(_ key: String, _ value: String?) {
        SecItemDelete(base(key) as CFDictionary)
        guard let value, !value.isEmpty else { return }
        var q = base(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }
}
