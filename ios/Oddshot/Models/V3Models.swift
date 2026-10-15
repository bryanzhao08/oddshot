import Foundation

// v3 contract types: role-specific recommendations + live context (see CONTRACT.md "v3").
// Everything is optional on the wire; decoding never fails the parent object.

// MARK: - Recommendation

struct Recommendation: Decodable, Hashable, Sendable {
    enum Confidence: String, Sendable { case low, medium, high }

    let role: String
    let headline: String
    let action: String
    let confidence: Confidence?
    let reasoning: [String]
    let disclaimer: String?
    let source: String   // "claude" | "rules" | other
    let model: String?

    enum CodingKeys: String, CodingKey { case role, headline, action, confidence, reasoning, disclaimer, source, model }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = (c.string(.role) ?? "general").lowercased()
        headline = c.string(.headline) ?? ""
        action = c.string(.action) ?? ""
        confidence = Confidence(rawValue: (c.string(.confidence) ?? "").lowercased())
        var r = c.strings(.reasoning)
        if r.isEmpty, let one = c.string(.reasoning), !one.isEmpty { r = [one] }
        reasoning = r.filter { !$0.isEmpty }
        disclaimer = c.string(.disclaimer).flatMap { $0.isEmpty ? nil : $0 }
        source = (c.string(.source) ?? "rules").lowercased()
        model = c.string(.model)
    }

    var isClaude: Bool { source == "claude" }
    var isEmpty: Bool { headline.isEmpty && action.isEmpty }
}

/// `recommendations: {[role]: Recommendation}`, decoded per entry so one bad role never sinks the rest.
struct RecommendationSet: Decodable, Hashable, Sendable {
    let byRole: [String: Recommendation]

    init(byRole: [String: Recommendation] = [:]) { self.byRole = byRole }

    private struct Entry: Decodable {
        let value: Recommendation?
        init(from decoder: Decoder) throws { value = try? Recommendation(from: decoder) }
    }
    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode([String: Entry].self)) ?? [:]
        var out: [String: Recommendation] = [:]
        for (k, v) in raw { if let r = v.value, !r.isEmpty { out[k.lowercased()] = r } }
        byRole = out
    }

    /// Exact role, falling back to the "general" wording.
    func `for`(_ role: Persona) -> Recommendation? {
        byRole[role.rawValue] ?? byRole["general"] ?? byRole["everyone"]
    }
    var isEmpty: Bool { byRole.isEmpty }
}

// MARK: - Live context

struct GameScore: Decodable, Hashable, Sendable {
    let home: String?
    let away: String?
    let homeTeam: String?
    let awayTeam: String?
    enum CodingKeys: String, CodingKey { case home, away, homeTeam, awayTeam }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func score(_ k: CodingKeys) -> String? {
            if let d = c.double(k) { return d == d.rounded() ? String(Int(d)) : String(d) }
            return c.string(k)
        }
        home = score(.home); away = score(.away)
        homeTeam = c.string(.homeTeam); awayTeam = c.string(.awayTeam)
    }

    var line: String? {
        guard home != nil || away != nil else { return nil }
        let a = [awayTeam, away].compactMap { $0 }.joined(separator: " ")
        let h = [homeTeam, home].compactMap { $0 }.joined(separator: " ")
        return "\(a) – \(h)"
    }
}

struct Imminent: Decodable, Hashable, Sendable {
    let type: String?
    let team: String?
    let confidence: Double?
    let text: String?
    enum CodingKeys: String, CodingKey { case type, team, confidence, text }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = c.string(.type); team = c.string(.team); text = c.string(.text)
        let conf = c.double(.confidence)
        confidence = conf.map { $0 > 1 ? $0 / 100 : $0 }
    }
    var isActive: Bool { type != nil || !(text ?? "").isEmpty }
    var label: String {
        if let text, !text.isEmpty { return text }
        return [team, type?.replacingOccurrences(of: "-", with: " ")].compactMap { $0 }.joined(separator: " ")
    }
}

struct LiveContext: Decodable, Hashable, Sendable {
    enum Kind: String, Sendable { case game, asset, other }
    let kind: Kind
    // game
    let league: String?
    let status: String?   // pre | in | post
    let clock: String?
    let period: String?
    let score: GameScore?
    let situation: String?
    let imminent: Imminent?
    let lastPlay: String?
    // asset
    let symbol: String?
    let price: Double?
    let change5m: Double?
    let change1h: Double?
    let source: String?
    let fetchedAt: Date?

    enum CodingKeys: String, CodingKey {
        case kind, league, status, clock, period, score, situation, imminent, lastPlay,
             symbol, price, change5m, change1h, source, fetchedAt, context
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if c.contains(.context), let inner = c.lenient(LiveContext.self, .context) { self = inner; return }
        symbol = c.string(.symbol)
        price = c.double(.price)
        let k = Kind(rawValue: (c.string(.kind) ?? "").lowercased())
        kind = k ?? (symbol != nil || price != nil ? .asset : (c.contains(.score) || c.contains(.status) ? .game : .other))
        league = c.string(.league)
        status = c.string(.status)?.lowercased()
        clock = c.string(.clock)
        if let d = c.double(.period) { period = String(Int(d)) } else { period = c.string(.period) }
        score = c.lenient(GameScore.self, .score)
        situation = c.string(.situation).flatMap { $0.isEmpty ? nil : $0 }
        imminent = c.lenient(Imminent.self, .imminent).flatMap { $0.isActive ? $0 : nil }
        lastPlay = c.string(.lastPlay).flatMap { $0.isEmpty ? nil : $0 }
        change5m = c.double(.change5m)
        change1h = c.double(.change1h)
        source = c.string(.source)
        fetchedAt = DateParsing.flexible(c, .fetchedAt)
    }

    var isEmpty: Bool {
        switch kind {
        case .game: score?.line == nil && situation == nil && clock == nil && imminent == nil
        case .asset: price == nil
        case .other: true
        }
    }
}

/// SSE `recommendation` event payload.
struct RecommendationEvent: Decodable, Sendable {
    let targetId: String
    let role: String
    let recommendation: Recommendation?
    enum CodingKeys: String, CodingKey { case targetId, role, recommendation }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        targetId = c.string(.targetId) ?? ""
        recommendation = c.lenient(Recommendation.self, .recommendation)
        role = (c.string(.role) ?? recommendation?.role ?? "general").lowercased()
    }
}

extension Persona {
    var emoji: String {
        switch self {
        case .photographer: "📸"
        case .trader: "📈"
        case .fan: "📣"
        case .journalist: "📰"
        case .general: "🔔"
        }
    }
    /// The app-wide active role (one-tap switcher, `@AppStorage(Prefs.shotPersona)`).
    static var active: Persona {
        Persona(rawValue: UserDefaults.standard.string(forKey: Prefs.shotPersona) ?? "") ?? .general
    }
}
