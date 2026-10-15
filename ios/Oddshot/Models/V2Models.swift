import Foundation

// v2 contract types: Shot List, Insights, Stories, Briefing, Forecast (see CONTRACT.md "v2").
// Every type decodes leniently: missing / null / mistyped fields fall back to defaults,
// unknown enum values map to `.other`, and one malformed element never sinks a list.

// MARK: - Lenient list payloads

/// Decodes `[T]` from a bare array or from an object wrapping one (`{shots: [...]}`, `{items: [...]}`, ...).
/// Elements that fail to decode are skipped.
struct LenientList<T: Decodable & Sendable>: Decodable, Sendable {
    let items: [T]

    private struct Element: Decodable {
        let value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }
    private struct AnyKey: CodingKey {
        var stringValue: String; var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    init(from decoder: Decoder) throws {
        if let arr = try? decoder.singleValueContainer().decode([Element].self) {
            items = arr.compactMap(\.value); return
        }
        if let o = try? decoder.container(keyedBy: AnyKey.self) {
            for k in ["shots", "insights", "stories", "items", "data", "results"] {
                if let key = AnyKey(stringValue: k), let arr = try? o.decode([Element].self, forKey: key) {
                    items = arr.compactMap(\.value); return
                }
            }
        }
        items = []
    }
}

extension KeyedDecodingContainer {
    func list<T: Decodable & Sendable>(_ type: T.Type, _ key: Key) -> [T] {
        lenient(LenientList<T>.self, key)?.items ?? []
    }
}

// MARK: - Forecast

struct ForecastDriver: Decodable, Hashable, Sendable, Identifiable {
    let feature: String
    let impact: Double
    let value: String?
    var id: String { feature }

    enum CodingKeys: String, CodingKey { case feature, impact, value, name }
    init(from decoder: Decoder) throws {
        // Accept a bare string driver too.
        if let s = try? decoder.singleValueContainer().decode(String.self) {
            feature = s; impact = 0; value = nil; return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        feature = c.string(.feature) ?? c.string(.name) ?? "signal"
        impact = c.double(.impact) ?? 0
        value = c.lenient(LenientString.self, .value)?.value
    }

    /// "timeToStartMin" / "time_to_start" → "Time to start min"
    var label: String {
        var out = ""
        for ch in feature.replacingOccurrences(of: "_", with: " ") {
            if ch.isUppercase, let last = out.last, last != " " { out.append(" ") }
            out.append(contentsOf: String(ch).lowercased())
        }
        return out.prefix(1).uppercased() + out.dropFirst()
    }

    var valueLabel: String? {
        guard let value, !value.isEmpty else { return nil }
        if let d = Double(value) {
            if d == d.rounded() && abs(d) < 1e6 { return String(Int(d)) }
            return String(format: abs(d) < 10 ? "%.2f" : "%.0f", d)
        }
        return value
    }
}

struct Forecast: Decodable, Hashable, Sendable {
    let pMove30: Double
    let expectedMovePts: Double?
    let drivers: [ForecastDriver]
    let model: String?
    let historyMinutes: Double?

    enum CodingKeys: String, CodingKey { case pMove30, expectedMovePts, drivers, model, historyMinutes, forecast }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Tolerate `{ forecast: {...} }` wrappers.
        if c.contains(.forecast), let inner = c.lenient(Forecast.self, .forecast) {
            self = inner; return
        }
        let p = c.double(.pMove30) ?? 0
        pMove30 = p > 1 ? p / 100 : p
        expectedMovePts = c.double(.expectedMovePts)
        drivers = c.list(ForecastDriver.self, .drivers)
        model = c.string(.model)
        historyMinutes = c.double(.historyMinutes)
    }

    var isHeuristic: Bool { (model ?? "heuristic").lowercased().hasPrefix("heuristic") }
    var modelLabel: String {
        guard let model, !model.isEmpty else { return "heuristic" }
        return model
    }
    var sentence: String { "\(Format.pct(pMove30)) chance of a 5+ pt swing in 30 min" }
}

// MARK: - Shot

enum ShotKind: String, CaseIterable, Sendable {
    case tension, turningPoint = "turning-point", decisive, closing, upcoming, momentum, other
    init(lenient s: String?) {
        let raw = (s ?? "").lowercased().replacingOccurrences(of: "_", with: "-")
        self = ShotKind(rawValue: raw) ?? (raw == "turningpoint" ? .turningPoint : .other)
    }
    var label: String {
        switch self {
        case .tension: "Tension"
        case .turningPoint: "Turning point"
        case .decisive: "Decisive"
        case .closing: "Closing"
        case .upcoming: "Upcoming"
        case .momentum: "Momentum"
        case .other: "Shot"
        }
    }
}

struct ShotWindow: Decodable, Hashable, Sendable {
    let startsAt: Date?
    let endsAt: Date?
    enum CodingKeys: String, CodingKey { case startsAt, endsAt }
    init(startsAt: Date? = nil, endsAt: Date? = nil) { self.startsAt = startsAt; self.endsAt = endsAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        startsAt = DateParsing.flexible(c, .startsAt)
        endsAt = DateParsing.flexible(c, .endsAt)
    }
}

struct PersonaTips: Decodable, Hashable, Sendable {
    let byPersona: [String: String]
    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode([String: LenientString].self)) ?? [:]
        var out: [String: String] = [:]
        for (k, v) in raw { if let s = v.value, !s.isEmpty { out[k.lowercased()] = s } }
        byPersona = out
    }
    init() { byPersona = [:] }

    func tip(for persona: Persona) -> String? {
        byPersona[persona.rawValue] ?? byPersona["general"] ?? byPersona["everyone"] ?? byPersona.values.sorted().first
    }
}

struct Shot: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let marketId: String
    let market: Market?
    let kind: ShotKind
    let headline: String
    let why: String
    let forecast: Forecast?
    let dramaScore: Double
    let window: ShotWindow
    let tips: PersonaTips
    let rank: Int
    let context: LiveContext?
    let recommendations: RecommendationSet

    enum CodingKeys: String, CodingKey {
        case id, marketId, market, kind, headline, why, forecast, dramaScore, window, tips, rank, context, recommendations
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        market = c.lenient(Market.self, .market)
        marketId = c.string(.marketId) ?? market?.id ?? ""
        id = c.string(.id) ?? (marketId.isEmpty ? UUID().uuidString : "shot-\(marketId)")
        kind = ShotKind(lenient: c.string(.kind))
        headline = c.string(.headline) ?? market?.title ?? "Something is brewing"
        why = c.string(.why) ?? ""
        forecast = c.lenient(Forecast.self, .forecast)
        let d = c.double(.dramaScore) ?? 0
        dramaScore = d <= 1 && d > 0 ? d * 100 : d
        window = c.lenient(ShotWindow.self, .window) ?? ShotWindow()
        tips = c.lenient(PersonaTips.self, .tips) ?? PersonaTips()
        rank = Int(c.double(.rank) ?? 0)
        context = c.lenient(LiveContext.self, .context).flatMap { $0.isEmpty ? nil : $0 }
        recommendations = c.lenient(RecommendationSet.self, .recommendations) ?? RecommendationSet()
    }

    /// Stable identity across ticks (the server may mint a new shot id each tick).
    var key: String { marketId.isEmpty ? id : marketId }
    var title: String { market?.title ?? headline }
    var source: String { market?.source ?? String(marketId.split(separator: ":").first ?? "") }
}

// MARK: - Insight

enum InsightType: String, CaseIterable, Sendable {
    case leadChange = "lead-change", upsetBrewing = "upset-brewing", lockIn = "lock-in",
         calmBeforeStorm = "calm-before-storm", beliefShift = "belief-shift", story, divergence, other
    init(lenient s: String?) {
        let raw = (s ?? "").lowercased().replacingOccurrences(of: "_", with: "-")
        self = InsightType(rawValue: raw) ?? .other
    }
    var label: String {
        switch self {
        case .leadChange: "Lead change"
        case .upsetBrewing: "Upset brewing"
        case .lockIn: "Lock-in"
        case .calmBeforeStorm: "Calm before storm"
        case .beliefShift: "Belief shift"
        case .story: "Story"
        case .divergence: "Divergence"
        case .other: "Insight"
        }
    }
}

struct Insight: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let type: InsightType
    let title: String
    let body: String
    let marketIds: [String]
    let category: MarketCategory
    let severity: Severity
    let createdAt: Date
    let matchedSubscriptions: [String]
    let context: LiveContext?
    let recommendations: RecommendationSet

    enum CodingKeys: String, CodingKey {
        case id, type, title, body, marketIds, marketId, category, severity, createdAt, matchedSubscriptions,
             context, recommendations
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = InsightType(lenient: c.string(.type))
        title = c.string(.title) ?? type.label
        body = c.string(.body) ?? ""
        var ids = c.strings(.marketIds)
        if ids.isEmpty, let one = c.string(.marketId) { ids = [one] }
        marketIds = ids
        category = MarketCategory(c.string(.category) ?? "other")
        severity = Severity(lenient: c.string(.severity))
        createdAt = DateParsing.flexible(c, .createdAt) ?? Date()
        matchedSubscriptions = c.strings(.matchedSubscriptions)
        context = c.lenient(LiveContext.self, .context).flatMap { $0.isEmpty ? nil : $0 }
        recommendations = c.lenient(RecommendationSet.self, .recommendations) ?? RecommendationSet()
        id = c.string(.id) ?? "\(type.rawValue)-\(ids.first ?? title)-\(Int(createdAt.timeIntervalSince1970))"
    }
}

// MARK: - Story

struct StoryMarket: Decodable, Hashable, Sendable, Identifiable {
    let id: String
    let title: String
    let from: Double?
    let to: Double?
    let delta: Double
    enum CodingKeys: String, CodingKey { case id, marketId, title, from, to, delta }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? c.string(.marketId) ?? UUID().uuidString
        title = c.string(.title) ?? "Market"
        from = c.double(.from); to = c.double(.to)
        delta = c.double(.delta) ?? ((to ?? 0) - (from ?? 0))
    }
}

struct Story: Decodable, Identifiable, Hashable, Sendable {
    enum Direction: String, Sendable { case up, down, mixed }
    let id: String
    let title: String
    let summary: String
    let eventKey: String?
    let category: MarketCategory
    let direction: Direction
    let markets: [StoryMarket]
    let strength: Double
    let startedAt: Date?
    let updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, title, summary, eventKey, category, direction, markets, strength, startedAt, updatedAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = c.string(.title) ?? "Markets moving together"
        summary = c.string(.summary) ?? ""
        eventKey = c.string(.eventKey)
        category = MarketCategory(c.string(.category) ?? "other")
        direction = Direction(rawValue: (c.string(.direction) ?? "").lowercased()) ?? .mixed
        markets = c.list(StoryMarket.self, .markets)
        let s = c.double(.strength) ?? 0
        strength = min(max(s > 1 ? s / 100 : s, 0), 1)
        startedAt = DateParsing.flexible(c, .startedAt)
        updatedAt = DateParsing.flexible(c, .updatedAt)
        id = c.string(.id) ?? eventKey ?? title
    }
}

// MARK: - Briefing

struct BriefingShift: Decodable, Hashable, Sendable, Identifiable {
    let marketId: String
    let title: String
    let from: Double?
    let to: Double?
    let delta: Double
    var id: String { marketId.isEmpty ? title : marketId }
    enum CodingKeys: String, CodingKey { case marketId, id, title, from, to, delta }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        marketId = c.string(.marketId) ?? c.string(.id) ?? ""
        title = c.string(.title) ?? "Market"
        from = c.double(.from); to = c.double(.to)
        delta = c.double(.delta) ?? ((to ?? 0) - (from ?? 0))
    }
}

struct Briefing: Decodable, Hashable, Sendable {
    let generatedAt: Date?
    let headline: String
    let bullets: [String]
    let biggestShifts: [BriefingShift]

    enum CodingKeys: String, CodingKey { case generatedAt, headline, bullets, biggestShifts }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = DateParsing.flexible(c, .generatedAt)
        headline = c.string(.headline) ?? ""
        bullets = c.strings(.bullets).filter { !$0.isEmpty }
        biggestShifts = c.list(BriefingShift.self, .biggestShifts)
    }

    var isEmpty: Bool { headline.isEmpty && bullets.isEmpty && biggestShifts.isEmpty }
}

// MARK: - Navigation

/// Enough to open MarketDetailView from anything that references a market (insight, story, briefing).
struct MarketRef: Hashable, Sendable {
    let id: String
    let title: String
    var outcome: String = ""
    var source: String = ""
    var url: URL?
    var probability: Double = 0
    var category: MarketCategory = "other"
    var market: Market?

    init(market: Market) {
        id = market.id; title = market.title; outcome = market.outcome; source = market.source
        url = market.url; probability = market.probability; category = market.category; self.market = market
    }
    init(id: String, title: String, probability: Double = 0, category: MarketCategory = "other") {
        self.id = id; self.title = title; self.probability = probability; self.category = category
        source = String(id.split(separator: ":").first ?? "")
    }
}
