import Foundation

/// A Polymarket market, normalized the same way as server/sources/polymarket.js.
struct Market: Codable, Sendable, Identifiable, Hashable {
    var id: String
    var title: String
    var eventTitle: String?
    var groupTitle: String?
    var outcome: String          // the side `probability` refers to ("Yes", "Chiefs", "Over")
    var otherOutcome: String?
    var probability: Double      // 0...1
    var volume24h: Double
    var category: Category
    var url: URL?
    var endDate: Date?
    var startTime: Date?
    var live: Bool
    var tokenId: String?

    var forecastInput: ForecastMarket {
        ForecastMarket(category: category.rawValue, endDate: endDate, startTime: startTime)
    }

    /// Short label for notifications: "Chiefs vs Bills", "Fed decision in October", or the question.
    var shortTitle: String {
        let t = eventTitle ?? title
        return t.count <= 60 ? t : String(t.prefix(57)) + "…"
    }

    /// "Japan Women's Open: Valentova vs Zhang" → ("Japan Women's Open", "Valentova vs Zhang").
    var split: (league: String?, name: String) {
        let t = eventTitle ?? title
        if let c = t.firstIndex(of: ":"), t.distance(from: t.startIndex, to: c) < 32 {
            let rest = t[t.index(after: c)...].trimmingCharacters(in: .whitespaces)
            if !rest.isEmpty { return (String(t[..<c]), rest) }
        }
        return (nil, t)
    }

    /// "Yes" markets read better as the question; named-outcome markets as the outcome.
    var sideLabel: String {
        let o = outcome.lowercased()
        if o == "yes" { return groupTitle ?? "Yes" }
        return outcome
    }

    var startsSoon: Bool {
        guard let s = startTime else { return false }
        let dt = s.timeIntervalSinceNow
        return dt > 0 && dt < 3600
    }
}

enum Category: String, Codable, Sendable, CaseIterable {
    case sports, politics, crypto, economics, entertainment, weather, tech, other

    var label: String {
        switch self {
        case .sports: "Sports"
        case .politics: "Politics"
        case .crypto: "Crypto"
        case .economics: "Economy"
        case .entertainment: "Culture"
        case .weather: "Weather"
        case .tech: "Tech"
        case .other: "Other"
        }
    }

    var symbol: String {
        switch self {
        case .sports: "sportscourt.fill"
        case .politics: "building.columns.fill"
        case .crypto: "bitcoinsign.circle.fill"
        case .economics: "chart.line.uptrend.xyaxis"
        case .entertainment: "sparkles.tv.fill"
        case .weather: "cloud.sun.fill"
        case .tech: "cpu.fill"
        case .other: "circle.grid.2x2.fill"
        }
    }
}

// MARK: - Polymarket (public gamma + CLOB APIs, no keys)

enum Polymarket {
    private static let gamma = "https://gamma-api.polymarket.com"
    private static let clob = "https://clob.polymarket.com"

    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 12
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    /// Top active markets by 24h volume (gamma caps a page at 100).
    static func topMarkets(limit: Int = 200) async throws -> [Market] {
        let offsets = Array(stride(from: 0, to: limit, by: 100))
        let pages = await withTaskGroup(of: [Market]?.self) { group in
            for o in offsets {
                group.addTask {
                    let url = URL(string: "\(gamma)/markets?active=true&closed=false&order=volume24hr&ascending=false&include_tag=true&limit=\(min(100, limit - o))&offset=\(o)")!
                    guard let (data, resp) = try? await session.data(from: url),
                          (resp as? HTTPURLResponse)?.statusCode == 200,
                          let raw = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
                    let now = Date()
                    return raw.compactMap { normalize($0, now: now) }
                }
            }
            var out: [[Market]] = []
            for await p in group { if let p { out.append(p) } }
            return out
        }
        if pages.isEmpty { throw URLError(.cannotLoadFromNetwork) }
        var seen = Set<String>()
        return pages.joined()
            .filter { seen.insert($0.id).inserted }
            .sorted { $0.volume24h > $1.volume24h }
    }

    /// Specific markets by id ("polymarket:123"), for followed matches outside the top list.
    static func markets(ids: [String]) async -> [Market] {
        let raw = ids.compactMap { $0.split(separator: ":").last.map(String.init) }
        guard !raw.isEmpty else { return [] }
        let q = raw.prefix(20).map { "id=\($0)" }.joined(separator: "&")
        guard let url = URL(string: "\(gamma)/markets?include_tag=true&\(q)"),
              let (data, _) = try? await session.data(from: url),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        let now = Date()
        return rows.compactMap { normalize($0, now: now) }
    }

    /// 1-minute price history for the last `hours` hours (CLOB prices-history).
    static func history(tokenId: String, hours: Double = 6) async -> [PricePoint] {
        let end = Int(Date().timeIntervalSince1970)
        let start = end - Int(hours * 3600)
        guard let url = URL(string: "\(clob)/prices-history?market=\(tokenId)&startTs=\(start)&endTs=\(end)&fidelity=1"),
              let (data, _) = try? await session.data(from: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = obj["history"] as? [[String: Any]] else { return [] }
        return rows.compactMap { r in
            guard let t = num(r["t"]), let p = num(r["p"]), (0...1).contains(p) else { return nil }
            return PricePoint(t: Date(timeIntervalSince1970: t), p: p)
        }
    }

    // MARK: normalize

    static func normalize(_ m: [String: Any], now: Date) -> Market? {
        let outcomes = jsonArray(m["outcomes"]).map { "\($0)" }
        let prices = jsonArray(m["outcomePrices"]).map { num($0) ?? .nan }
        guard !outcomes.isEmpty, let first = prices.first, first.isFinite, let rawId = m["id"] else { return nil }
        let idx = outcomes.firstIndex { $0.lowercased() == "yes" } ?? 0
        guard idx < prices.count, (0...1).contains(prices[idx]) else { return nil }

        let ev = (m["events"] as? [[String: Any]])?.first
        let tagList = (m["tags"] as? [[String: Any]]) ?? (ev?["tags"] as? [[String: Any]]) ?? []
        let tags = tagList.compactMap { (($0["slug"] ?? $0["label"]) as? String)?.lowercased() }
        let question = m["question"] as? String ?? ""
        let evTitle = ev?["title"] as? String
        let category = categorize(tags: tags, text: "\(question) \(evTitle ?? "")")
        let slug = (ev?["slug"] as? String) ?? (m["slug"] as? String) ?? ""
        let start = date(m["gameStartTime"]) ?? date(m["eventStartTime"]) ?? date(ev?["startTime"])
        let end = date(m["endDate"])
        let closed = (m["closed"] as? Bool) ?? false

        var live = false
        if (ev?["ended"] as? Bool) == true || closed {
            live = false
        } else if (ev?["live"] as? Bool) == true {
            live = true
        } else if let s = start, m["gameStartTime"] != nil || m["sportsMarketType"] != nil || category == .sports {
            live = now >= s && now <= s.addingTimeInterval(4 * 3600)
        } else if category == .sports, let e = end {
            live = e > now && e.timeIntervalSince(now) <= 6 * 3600
        }

        return Market(
            id: "polymarket:\(rawId)",
            title: question.isEmpty ? (evTitle ?? slug) : question,
            eventTitle: evTitle,
            groupTitle: m["groupItemTitle"] as? String,
            outcome: outcomes[idx],
            otherOutcome: outcomes.count == 2 ? outcomes[1 - idx] : nil,
            probability: prices[idx],
            volume24h: num(m["volume24hr"]) ?? num(m["volume24hrClob"]) ?? 0,
            category: category,
            url: URL(string: "https://polymarket.com/event/\(slug)"),
            endDate: end,
            startTime: start,
            live: live,
            tokenId: jsonArray(m["clobTokenIds"]).dropFirst(idx).first.map { "\($0)" }
        )
    }

    private static let categoryRules: [(Category, String)] = [
        (.sports, #"^(sports|nfl|nba|mlb|nhl|wnba|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma|boxing|f1|formula-1|cricket|esports|cfb|ncaab|cbb|epl|ucl|la-liga|champions-league|olympics|nascar|league-of-legends|counter-strike-2|dota-2|valorant|chess)$"#),
        (.crypto, #"^(crypto|bitcoin|ethereum|solana|xrp|crypto-prices|dogecoin|stablecoins|airdrops|memecoins)$"#),
        (.weather, #"^(weather|climate|hurricanes?|temperature|global-temp|natural-disasters|earthquakes?|snow|rain)$"#),
        (.tech, #"^(tech|ai|science|openai|anthropic|spacex|space|ai-rankings|big-tech|apple|google|nvidia|gpt-releases|compute)$"#),
        (.economics, #"^(economy|economics|fed|fed-rates|fomc|finance|business|macro-indicators|inflation|cpi|us-cpi|gdp|stocks|commodities|interest-rates|recession|tariffs|economic-policy|jobs|ipo|ipos|earnings|equities|corporate-financials|global-rates)$"#),
        (.entertainment, #"^(pop-culture|culture|entertainment|movies|music|awards|oscars|grammys|emmys|tv|celebrities|tweets-markets|youtube|twitter|elon-musk|mentions|box-office|gaming|video-games)$"#),
        (.politics, #"^(politics|elections|geopolitics|world|us-presidential-election|midterms|global-elections|world-elections|trump|congress|senate|foreign-policy|middle-east|ukraine|israel|iran|china)$"#),
    ]
    private static let keywordRules: [(Category, String)] = [
        (.sports, #"\b(vs\.?|win on \d{4}|nfl|nba|mlb|nhl|super bowl|world series|champions league|premier league|grand slam|o/u|spread:|game \d winner|bo3|bo5)\b"#),
        (.crypto, #"\b(bitcoin|btc|ethereum|eth|solana|crypto|xrp|dogecoin)\b"#),
        (.weather, #"\b(hurricane|temperature|weather|rainfall|snowfall|tornado|heat)\b"#),
        (.economics, #"\b(fed|interest rates?|inflation|cpi|gdp|recession|s&p|nasdaq|unemployment|tariff|ipo)\b"#),
        (.tech, #"\b(ai|openai|anthropic|gpt|gemini|spacex|apple|google|nvidia|tesla)\b"#),
        (.entertainment, #"\b(tweets?|oscars?|grammys?|album|movie|box office|taylor swift|mrbeast|netflix)\b"#),
        (.politics, #"\b(election|president|senate|house|governor|minister|trump|ceasefire|invade|war|parliament|nominee|mayor)\b"#),
    ]

    static func categorize(tags: [String], text: String) -> Category {
        for (cat, re) in categoryRules where tags.contains(where: { $0.range(of: re, options: .regularExpression) != nil }) { return cat }
        for (cat, re) in keywordRules where text.range(of: re, options: [.regularExpression, .caseInsensitive]) != nil { return cat }
        return .other
    }

    private static func jsonArray(_ v: Any?) -> [Any] {
        if let a = v as? [Any] { return a }
        guard let s = v as? String, let d = s.data(using: .utf8), let a = try? JSONSerialization.jsonObject(with: d) as? [Any] else { return [] }
        return a
    }

    private static func num(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String { return Double(s) }
        return nil
    }

    nonisolated(unsafe) private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let isoPlain = ISO8601DateFormatter()

    private static func date(_ v: Any?) -> Date? {
        guard var s = v as? String, !s.isEmpty else { return nil }
        // gamma sometimes uses "2026-10-15 05:30:00+00"
        s = s.replacingOccurrences(of: " ", with: "T")
        if s.hasSuffix("+00") { s = String(s.dropLast(3)) + "Z" }
        if s.count == 10 { s += "T00:00:00Z" }
        return iso.date(from: s) ?? isoPlain.date(from: s)
    }
}
