import Foundation

// MARK: - Lenient decoding helpers
//
// The backend is evolving concurrently, so every model decodes defensively:
// missing keys, nulls, wrong types (number-as-string) and unknown enum values
// never fail the whole payload.

extension KeyedDecodingContainer {
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    func double(_ key: Key) -> Double? {
        if let d = lenient(Double.self, key) { return d }
        if let s = lenient(String.self, key) { return Double(s) }
        return nil
    }

    func bool(_ key: Key) -> Bool? {
        if let b = lenient(Bool.self, key) { return b }
        if let i = lenient(Int.self, key) { return i != 0 }
        return nil
    }

    func string(_ key: Key) -> String? {
        if let s = lenient(String.self, key) { return s }
        if let d = lenient(Double.self, key) { return String(d) }
        return nil
    }

    func strings(_ key: Key) -> [String] {
        lenient([LenientString].self, key)?.compactMap(\.value) ?? []
    }
}

/// Decodes a string, a number, or an object carrying a name-ish field.
struct LenientString: Decodable, Sendable {
    let value: String?
    init(from decoder: Decoder) throws {
        if let c = try? decoder.singleValueContainer() {
            if let s = try? c.decode(String.self) { value = s; return }
            if let d = try? c.decode(Double.self) { value = String(d); return }
        }
        struct AnyKey: CodingKey {
            var stringValue: String; var intValue: Int? { nil }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { nil }
        }
        if let o = try? decoder.container(keyedBy: AnyKey.self) {
            for k in ["label", "name", "feature", "text", "description", "key"] {
                if let key = AnyKey(stringValue: k), let s = try? o.decode(String.self, forKey: key) {
                    value = s; return
                }
            }
        }
        value = nil
    }
}

enum DateParsing {
    private static let frac = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plain = Date.ISO8601FormatStyle()

    static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return (try? frac.parse(s)) ?? (try? plain.parse(s))
    }

    /// Accepts epoch ms (number), epoch seconds, or ISO strings.
    static func flexible<K>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Date? {
        if let d = c.lenient(Double.self, key) {
            return Date(timeIntervalSince1970: d > 10_000_000_000 ? d / 1000 : d)
        }
        return parse(c.lenient(String.self, key))
    }
}

// MARK: - Category

struct MarketCategory: Hashable, Sendable, Codable, Identifiable, Comparable {
    let raw: String
    var id: String { raw }

    init(_ raw: String) { self.raw = raw.lowercased() }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        raw = ((try? c.decode(String.self)) ?? "other").lowercased()
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(raw)
    }

    static let known: [MarketCategory] = ["sports", "politics", "crypto", "economics", "entertainment", "weather", "tech", "other"].map { MarketCategory($0) }

    var label: String { raw.prefix(1).uppercased() + raw.dropFirst() }
    var symbol: String {
        switch raw {
        case "sports": "sportscourt.fill"
        case "politics": "building.columns.fill"
        case "crypto": "bitcoinsign.circle.fill"
        case "economics": "chart.line.uptrend.xyaxis"
        case "entertainment": "music.mic"
        case "weather": "cloud.bolt.rain.fill"
        case "tech": "cpu.fill"
        default: "circle.hexagongrid.fill"
        }
    }
    static func < (a: Self, b: Self) -> Bool {
        let ia = known.firstIndex(of: a) ?? 99, ib = known.firstIndex(of: b) ?? 99
        return ia == ib ? a.raw < b.raw : ia < ib
    }
}

extension MarketCategory: ExpressibleByStringLiteral {
    init(stringLiteral value: String) { self.init(value) }
}

// MARK: - Market

struct Market: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let source: String
    let title: String
    let outcome: String
    let probability: Double
    let volume24h: Double
    let liquidity: Double
    let category: MarketCategory
    let tags: [String]
    let url: URL?
    let endDate: Date?
    let live: Bool
    let change1h: Double?
    /// v2: scheduled start of the underlying event, if known.
    let startTime: Date?
    /// v2: groups sibling markets of the same event.
    let eventKey: String?

    enum CodingKeys: String, CodingKey {
        case id, source, title, outcome, probability, volume24h, liquidity, category, tags, url, endDate, live, change1h,
             startTime, eventKey
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? UUID().uuidString
        source = c.string(.source) ?? "unknown"
        title = c.string(.title) ?? "Untitled market"
        outcome = c.string(.outcome) ?? "Yes"
        probability = c.double(.probability) ?? 0
        volume24h = c.double(.volume24h) ?? 0
        liquidity = c.double(.liquidity) ?? 0
        category = MarketCategory(c.string(.category) ?? "other")
        tags = c.strings(.tags)
        url = c.string(.url).flatMap(URL.init(string:))
        endDate = DateParsing.flexible(c, .endDate)
        live = c.bool(.live) ?? false
        change1h = c.double(.change1h)
        startTime = DateParsing.flexible(c, .startTime)
        eventKey = c.string(.eventKey)
    }

    var sourceLabel: String { Market.sourceLabel(source) }
    static func sourceLabel(_ s: String) -> String {
        switch s.lowercased() {
        case "polymarket": "Polymarket"
        case "kalshi": "Kalshi"
        default: s.capitalized
        }
    }
}

// MARK: - Mover

struct Mover: Decodable, Identifiable, Hashable, Sendable {
    let market: Market
    let change1h: Double
    let change5m: Double
    let vol: Double
    var id: String { market.id }

    enum CodingKeys: String, CodingKey { case market, change1h, change5m, vol }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        market = try c.decode(Market.self, forKey: .market)
        change1h = c.double(.change1h) ?? market.change1h ?? 0
        change5m = c.double(.change5m) ?? 0
        vol = c.double(.vol) ?? 0
    }
}

// MARK: - History

struct PricePoint: Decodable, Hashable, Sendable, Identifiable {
    let t: Date
    let p: Double
    var id: Date { t }

    enum CodingKeys: String, CodingKey { case t, p }
    init(t: Date, p: Double) { self.t = t; self.p = p }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        t = DateParsing.flexible(c, .t) ?? .distantPast
        p = c.double(.p) ?? 0
    }
}

struct MarketHistory: Decodable, Sendable {
    let marketId: String
    let points: [PricePoint]
    enum CodingKeys: String, CodingKey { case marketId, points }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        marketId = c.string(.marketId) ?? ""
        points = (c.lenient([PricePoint].self, .points) ?? []).filter { $0.t != .distantPast }
    }
}

// MARK: - Volatility index

struct VixPoint: Decodable, Hashable, Sendable {
    let t: Date
    let overall: Double
    enum CodingKeys: String, CodingKey { case t, overall }
    init(t: Date, overall: Double) { self.t = t; self.overall = overall }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        t = DateParsing.flexible(c, .t) ?? .distantPast
        overall = c.double(.overall) ?? 0
    }
}

struct VolatilityIndex: Decodable, Sendable, Equatable {
    var overall: Double
    var byCategory: [MarketCategory: Double]
    var updatedAt: Date?
    var history: [VixPoint]?

    enum CodingKeys: String, CodingKey { case overall, byCategory, updatedAt, history }
    init(overall: Double = 0, byCategory: [MarketCategory: Double] = [:]) {
        self.overall = overall; self.byCategory = byCategory
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        overall = c.double(.overall) ?? 0
        let raw = c.lenient([String: LenientDouble].self, .byCategory) ?? [:]
        var out: [MarketCategory: Double] = [:]
        for (k, v) in raw { if let d = v.value { out[MarketCategory(k)] = d } }
        byCategory = out
        updatedAt = DateParsing.flexible(c, .updatedAt)
        history = c.lenient([VixPoint].self, .history)
    }

    enum Mood: String { case calm = "Calm", active = "Active", heated = "Heated", chaotic = "Chaotic" }
    static func mood(_ v: Double) -> Mood {
        switch v {
        case ..<25: .calm
        case ..<50: .active
        case ..<75: .heated
        default: .chaotic
        }
    }
}

struct LenientDouble: Decodable, Sendable {
    let value: Double?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { value = d }
        else if let s = try? c.decode(String.self) { value = Double(s) }
        else { value = nil }
    }
}

// MARK: - Spike

enum Severity: String, CaseIterable, Sendable, Codable, Identifiable, Comparable {
    case info, notable, major
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var rank: Int { Severity.allCases.firstIndex(of: self) ?? 0 }
    static func < (a: Self, b: Self) -> Bool { a.rank < b.rank }
    init(lenient s: String?) { self = Severity(rawValue: (s ?? "").lowercased()) ?? .info }
}

struct MLSignal: Decodable, Hashable, Sendable {
    let pReal: Double?
    let label: String?
    let drivers: [String]
    enum CodingKeys: String, CodingKey { case pReal, label, drivers }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pReal = c.double(.pReal)
        label = c.string(.label)
        drivers = c.strings(.drivers)
    }
}

struct Spike: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let marketId: String
    let title: String
    let source: String
    let category: MarketCategory
    let tags: [String]
    let url: URL?
    let outcome: String
    let from: Double
    let to: Double
    let delta: Double
    let windowMs: Double
    let zScore: Double?
    let severity: Severity
    let live: Bool
    let demo: Bool
    let detectedAt: Date
    let matchedSubscriptions: [String]
    let ml: MLSignal?
    // v3
    /// "price" (default) or "volatility".
    let kind: String
    let volRatio: Double?
    let volShort: Double?
    let volBase: Double?
    let context: LiveContext?
    let recommendations: RecommendationSet

    enum CodingKeys: String, CodingKey {
        case id, marketId, title, source, category, tags, url, outcome, from, to, delta, windowMs, zScore,
             severity, live, demo, detectedAt, matchedSubscriptions, ml,
             kind, volRatio, volShort, volBase, context, recommendations
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? UUID().uuidString
        marketId = c.string(.marketId) ?? ""
        title = c.string(.title) ?? "Unknown market"
        source = c.string(.source) ?? "unknown"
        category = MarketCategory(c.string(.category) ?? "other")
        tags = c.strings(.tags)
        url = c.string(.url).flatMap(URL.init(string:))
        outcome = c.string(.outcome) ?? "Yes"
        let f = c.double(.from) ?? 0, t = c.double(.to) ?? 0
        from = f; to = t
        delta = c.double(.delta) ?? (t - f)
        windowMs = c.double(.windowMs) ?? 0
        zScore = c.double(.zScore)
        severity = Severity(lenient: c.string(.severity))
        live = c.bool(.live) ?? false
        demo = c.bool(.demo) ?? false
        detectedAt = DateParsing.flexible(c, .detectedAt) ?? Date()
        matchedSubscriptions = c.strings(.matchedSubscriptions)
        ml = c.lenient(MLSignal.self, .ml)
        kind = (c.string(.kind) ?? "price").lowercased()
        volRatio = c.double(.volRatio)
        volShort = c.double(.volShort)
        volBase = c.double(.volBase)
        context = c.lenient(LiveContext.self, .context).flatMap { $0.isEmpty ? nil : $0 }
        recommendations = c.lenient(RecommendationSet.self, .recommendations) ?? RecommendationSet()
    }

    var isVolatility: Bool { kind == "volatility" }

    var points: Int { Int((delta * 100).rounded()) }
    var signedPoints: String { points >= 0 ? "+\(points)" : "−\(abs(points))" }
    var windowLabel: String { Format.window(windowMs) }

    /// Plain-English description used for notifications.
    var plainEnglish: String {
        let verb = delta >= 0 ? "jumped" : "dropped"
        let headline = outcome.isEmpty || outcome.lowercased() == "yes" ? title : "\(outcome) — \(title)"
        var s = "\(headline): odds \(verb) from \(Format.pct(from)) to \(Format.pct(to)) in \(windowLabel)."
        if live { s += " Event looks live right now." }
        if demo { s += " (demo)" }
        return s
    }
}

// MARK: - Subscription

struct SubscriptionMatch: Codable, Hashable, Sendable {
    var keywords: [String] = []
    var categories: [String] = []
    var marketIds: [String] = []
    var sources: [String] = []

    init(keywords: [String] = [], categories: [String] = [], marketIds: [String] = [], sources: [String] = []) {
        self.keywords = keywords; self.categories = categories; self.marketIds = marketIds; self.sources = sources
    }
    enum CodingKeys: String, CodingKey { case keywords, categories, marketIds, sources }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        keywords = c.strings(.keywords)
        categories = c.strings(.categories)
        marketIds = c.strings(.marketIds)
        sources = c.strings(.sources)
    }
}

struct Webhook: Codable, Hashable, Sendable {
    enum Kind: String, CaseIterable, Codable, Sendable, Identifiable {
        case generic, discord, slack, ntfy
        var id: String { rawValue }
        var label: String { self == .ntfy ? "ntfy.sh" : rawValue.capitalized }
    }
    var type: Kind
    var url: String

    init(type: Kind, url: String) { self.type = type; self.url = url }
    enum CodingKeys: String, CodingKey { case type, url }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = Kind(rawValue: c.string(.type) ?? "") ?? .generic
        url = c.string(.url) ?? ""
    }
}

enum Persona: String, CaseIterable, Codable, Sendable, Identifiable {
    case photographer, trader, fan, journalist, general
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    /// Label used by the Shot List persona picker ("general" reads as "Everyone" there).
    var shotLabel: String { self == .general ? "Everyone" : label }
    var shotSymbol: String { self == .general ? "person.3.fill" : symbol }
    var symbol: String {
        switch self {
        case .photographer: "camera.fill"
        case .trader: "chart.xyaxis.line"
        case .fan: "megaphone.fill"
        case .journalist: "newspaper.fill"
        case .general: "bell.fill"
        }
    }
    var blurb: String {
        switch self {
        case .photographer: "Sports + entertainment, live events only, 5+ pt moves"
        case .trader: "Every category, 3+ pt moves"
        case .fan: "Sports, 5+ pt moves"
        case .journalist: "Politics + economics, 5+ pt moves"
        case .general: "Custom rules"
        }
    }

    /// Preset subscription for this persona.
    var preset: Subscription {
        var s = Subscription.blank
        s.persona = self
        switch self {
        case .photographer:
            s.name = "Photographer — live action"
            s.match.categories = ["sports", "entertainment"]; s.liveOnly = true; s.minDelta = 0.05
        case .trader:
            s.name = "Trader — all markets"; s.minDelta = 0.03
        case .fan:
            s.name = "Fan — sports"; s.match.categories = ["sports"]; s.minDelta = 0.05
        case .journalist:
            s.name = "Journalist — politics & economy"
            s.match.categories = ["politics", "economics"]; s.minDelta = 0.05
        case .general:
            s.name = "My alert"
        }
        return s
    }
}

struct Subscription: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var persona: Persona
    var match: SubscriptionMatch
    var minDelta: Double
    var minSeverity: Severity
    var liveOnly: Bool
    var webhook: Webhook?
    var createdAt: String?

    static var blank: Subscription {
        Subscription(id: "", name: "", persona: .general, match: SubscriptionMatch(), minDelta: 0.05,
                     minSeverity: .info, liveOnly: false, webhook: nil, createdAt: nil)
    }

    init(id: String, name: String, persona: Persona, match: SubscriptionMatch, minDelta: Double,
         minSeverity: Severity, liveOnly: Bool, webhook: Webhook?, createdAt: String?) {
        self.id = id; self.name = name; self.persona = persona; self.match = match; self.minDelta = minDelta
        self.minSeverity = minSeverity; self.liveOnly = liveOnly; self.webhook = webhook; self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey { case id, name, persona, match, minDelta, minSeverity, liveOnly, webhook, createdAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? UUID().uuidString
        name = c.string(.name) ?? "Untitled"
        persona = Persona(rawValue: c.string(.persona) ?? "") ?? .general
        match = c.lenient(SubscriptionMatch.self, .match) ?? SubscriptionMatch()
        minDelta = c.double(.minDelta) ?? 0.05
        minSeverity = Severity(lenient: c.string(.minSeverity))
        liveOnly = c.bool(.liveOnly) ?? false
        webhook = c.lenient(Webhook.self, .webhook)
        createdAt = c.string(.createdAt)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if !id.isEmpty { try c.encode(id, forKey: .id) }
        try c.encode(name, forKey: .name)
        try c.encode(persona, forKey: .persona)
        try c.encode(match, forKey: .match)
        try c.encode(minDelta, forKey: .minDelta)
        try c.encode(minSeverity, forKey: .minSeverity)
        try c.encode(liveOnly, forKey: .liveOnly)
        if let webhook, !webhook.url.trimmingCharacters(in: .whitespaces).isEmpty {
            try c.encode(webhook, forKey: .webhook)
        } else {
            try c.encodeNil(forKey: .webhook)
        }
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
    }

    var summary: String {
        var parts: [String] = []
        parts.append(match.categories.isEmpty ? "Any category" : match.categories.map { $0.capitalized }.joined(separator: " + "))
        if !match.keywords.isEmpty { parts.append("“" + match.keywords.joined(separator: "”, “") + "”") }
        if !match.marketIds.isEmpty { parts.append("\(match.marketIds.count) market\(match.marketIds.count == 1 ? "" : "s")") }
        parts.append("≥\(Int((minDelta * 100).rounded())) pts")
        if minSeverity != .info { parts.append("\(minSeverity.label)+") }
        if liveOnly { parts.append("Live only") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Health

struct SourceHealth: Decodable, Sendable, Hashable {
    let ok: Bool
    let count: Int
    let error: String?
    enum CodingKeys: String, CodingKey { case ok, count, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.bool(.ok) ?? false
        count = Int(c.double(.count) ?? 0)
        error = c.string(.error)
    }
}

struct Health: Decodable, Sendable {
    let ok: Bool
    let lastPollAt: Date?
    let marketCount: Int
    let sources: [String: SourceHealth]
    enum CodingKeys: String, CodingKey { case ok, lastPollAt, marketCount, sources }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.bool(.ok) ?? false
        lastPollAt = DateParsing.flexible(c, .lastPollAt)
        marketCount = Int(c.double(.marketCount) ?? 0)
        sources = c.lenient([String: SourceHealth].self, .sources) ?? [:]
    }
}

struct TestResult: Decodable, Sendable {
    let ok: Bool
    let error: String?
    enum CodingKeys: String, CodingKey { case ok, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.bool(.ok) ?? false
        error = c.string(.error)
    }
}

// MARK: - Formatting

enum Format {
    static func pct(_ p: Double) -> String { "\(Int((p * 100).rounded()))%" }

    static func pts(_ d: Double, decimals: Bool = false) -> String {
        let v = d * 100
        let s = decimals ? String(format: "%.1f", abs(v)) : "\(Int(abs(v).rounded()))"
        return (v >= 0 ? "+" : "−") + s
    }

    static func window(_ ms: Double) -> String {
        let sec = ms / 1000
        if sec <= 0 { return "moments" }
        if sec < 90 { return "\(Int(sec.rounded()))s" }
        let min = sec / 60
        if min < 90 { return "\(Int(min.rounded())) min" }
        return String(format: "%.1f h", min / 60)
    }

    static func money(_ v: Double) -> String {
        switch v {
        case 1_000_000...: String(format: "$%.1fM", v / 1_000_000)
        case 1_000...: String(format: "$%.0fK", v / 1_000)
        default: String(format: "$%.0f", v)
        }
    }
}
