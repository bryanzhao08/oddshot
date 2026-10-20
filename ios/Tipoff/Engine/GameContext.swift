import Foundation

/// What's going on in a match right now, in plain words: "Tiebreak in set 2", "Ann Li can close out the set",
/// "Chiefs in the red zone". Built from ESPN's live scoreboard, the odds themselves, and (optionally) X posts.
struct GameMoment: Sendable, Hashable {
    var symbol: String          // SF Symbol
    var emoji: String           // for notifications
    var headline: String
    var detail: String?         // score line or supporting fact
    var mustSee = false
}

/// One live game from ESPN's public scoreboard (no key needed).
struct LiveGame {
    var id: String
    var league: String
    var teamIds: [String]
    var abbrs: [String]
    var sport: String
    var sides: [[String]]       // name aliases for each side, used for matching
    var names: [String]         // display name for each side
    var scores: [Int?]
    var sets: [[Int]]           // tennis: games per set for each side
    var period: Int
    var clock: String?
    var raw: [String: Any]      // situation fields
    var lastPlay: String?
}

extension LiveGame: @unchecked Sendable {}

enum ESPN {
    private static let base = "https://site.web.api.espn.com/apis/site/v2/sports"
    private static let leagues: [(String, String)] = [
        ("football", "nfl"), ("football", "college-football"), ("basketball", "nba"), ("basketball", "wnba"),
        ("baseball", "mlb"), ("hockey", "nhl"), ("soccer", "eng.1"), ("soccer", "usa.1"), ("soccer", "esp.1"),
        ("soccer", "uefa.champions"), ("soccer", "ita.1"), ("soccer", "ger.1"), ("soccer", "fra.1"),
        ("tennis", "atp"), ("tennis", "wta"),
    ]

    /// Every game in progress across the leagues we know.
    static func liveGames() async -> [LiveGame] {
        await withTaskGroup(of: [LiveGame].self) { group in
            for (sport, league) in leagues {
                group.addTask {
                    guard let url = URL(string: "\(base)/\(sport)/\(league)/scoreboard"),
                          let (data, _) = try? await URLSession.shared.data(from: url),
                          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
                    return parse(obj, sport: sport, league: league)
                }
            }
            var all: [LiveGame] = []
            for await g in group { all += g }
            return all
        }
    }

    private static func parse(_ obj: [String: Any], sport: String, league: String) -> [LiveGame] {
        let events = obj["events"] as? [[String: Any]] ?? []
        // Tennis nests matches under tournament groupings; team sports have one competition per event.
        let comps: [[String: Any]] = events.flatMap { e -> [[String: Any]] in
            if let groups = e["groupings"] as? [[String: Any]] { return groups.flatMap { $0["competitions"] as? [[String: Any]] ?? [] } }
            return e["competitions"] as? [[String: Any]] ?? []
        }
        return comps.compactMap { c in
            let status = c["status"] as? [String: Any] ?? [:]
            guard ((status["type"] as? [String: Any])?["state"] as? String) == "in" else { return nil }
            var competitors = c["competitors"] as? [[String: Any]] ?? []
            guard competitors.count == 2 else { return nil }
            // Home first for team sports, so scores line up with `names`.
            if competitors[0]["homeAway"] as? String == "away" { competitors.reverse() }
            var sides: [[String]] = [], names: [String] = []
            for p in competitors {
                if let a = p["athlete"] as? [String: Any] {
                    let full = a["displayName"] as? String ?? ""
                    let last = full.split(separator: " ").last.map(String.init) ?? full
                    sides.append([full] + (last.count >= 5 ? [last] : []))
                    names.append(full)
                } else {
                    let t = p["team"] as? [String: Any] ?? [:]
                    let keys = ["displayName", "shortDisplayName", "name", "location"]
                    sides.append(keys.compactMap { t[$0] as? String }.filter { $0.count >= 4 })
                    names.append(t["shortDisplayName"] as? String ?? t["displayName"] as? String ?? "?")
                }
            }
            let sets = competitors.map { p in (p["linescores"] as? [[String: Any]] ?? []).compactMap { ($0["value"] as? NSNumber)?.intValue } }
            let situation = c["situation"] as? [String: Any] ?? [:]
            let last = (situation["lastPlay"] as? [String: Any])?["text"] as? String
                ?? ((c["details"] as? [[String: Any]])?.last?["text"] as? String)
                ?? ((c["details"] as? [[String: Any]])?.last.flatMap { ($0["type"] as? [String: Any])?["text"] as? String })
            let ids = competitors.map { ($0["team"] as? [String: Any])?["id"] as? String ?? $0["id"] as? String ?? "" }
            let abbrs = competitors.map { ($0["team"] as? [String: Any])?["abbreviation"] as? String ?? "" }
            return LiveGame(id: c["id"] as? String ?? "", league: league, teamIds: ids, abbrs: abbrs, sport: sport, sides: sides, names: names,
                            scores: competitors.map { Int($0["score"] as? String ?? "") ?? ($0["score"] as? NSNumber)?.intValue },
                            sets: sets, period: (status["period"] as? NSNumber)?.intValue ?? 0,
                            clock: status["displayClock"] as? String, raw: situation, lastPlay: last)
        }
    }

    /// Full match data (play-by-play / commentary) for the in-game models.
    static func summary(_ g: LiveGame) async -> [String: Any]? {
        guard let url = URL(string: "\(base)/\(g.sport)/\(g.league)/summary?event=\(g.id)"),
              let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// Both sides have to be named in the market for a match (keeps false matches out).
    static func match(_ m: Market, in games: [LiveGame]) -> LiveGame? {
        let text = " \((m.eventTitle ?? "") + " " + m.title) ".lowercased()
        let hits = games.filter { g in
            g.sides.allSatisfy { aliases in aliases.contains { text.range(of: "\\b\(NSRegularExpression.escapedPattern(for: $0.lowercased()))\\b", options: .regularExpression) != nil } }
        }
        return hits.count == 1 ? hits[0] : nil
    }
}

// MARK: - Turning a game into a moment

extension LiveGame {
    var moment: GameMoment? {
        switch sport {
        case "tennis": return tennis
        case "football": return football
        case "basketball": return basketball
        case "baseball": return baseball
        case "hockey": return hockey
        case "soccer": return soccer
        default: return nil
        }
    }

    var scoreLine: String? {
        guard let a = scores.first ?? nil, let b = scores.last ?? nil else { return nil }
        return "\(names[0]) \(a), \(names[1]) \(b)"
    }
    private var diff: Int? {
        guard let a = scores.first ?? nil, let b = scores.last ?? nil else { return nil }
        return abs(a - b)
    }
    private var leader: String? {
        guard let a = scores.first ?? nil, let b = scores.last ?? nil, a != b else { return nil }
        return a > b ? names[0] : names[1]
    }
    /// Soccer match minute from "63'" or "90'+2'".
    var minute: Int? {
        guard sport == "soccer", let c = clock else { return nil }
        let parts = c.replacingOccurrences(of: "'", with: "").split(separator: "+").compactMap { Int($0) }
        return parts.isEmpty ? nil : parts.reduce(0, +)
    }

    var clockSeconds: Int? {
        guard let c = clock else { return nil }
        let parts = c.split(separator: ":").compactMap { Double($0) }
        return parts.count == 2 ? Int(parts[0] * 60 + parts[1]) : parts.first.map(Int.init)
    }

    private var tennis: GameMoment? {
        guard sets.count == 2, let n = [sets[0].count, sets[1].count].min(), n > 0 else { return nil }
        let a = sets[0], b = sets[1], cur = n - 1
        var won = [0, 0]
        for i in 0..<cur { if a[i] > b[i] { won[0] += 1 } else if b[i] > a[i] { won[1] += 1 } }
        let (ga, gb) = (a[cur], b[cur])
        let deciding = won[0] == won[1] && cur >= 2
        let score = "Set \(cur + 1): \(names[0].lastName) \(ga)-\(gb) \(names[1].lastName), sets \(won[0])-\(won[1])"
        let lead = ga > gb ? 0 : 1, top = max(ga, gb), low = min(ga, gb)
        let leaderName = names[lead]
        let leaderUpASet = won[lead] > won[1 - lead]

        if ga == 6 && gb == 6 {
            return GameMoment(symbol: "tennisball.fill", emoji: "🎾", headline: deciding ? "Final-set tiebreak" : "Tiebreak in set \(cur + 1)",
                              detail: score, mustSee: true)
        }
        if (top == 5 && top - low >= 1) || (top == 6 && low == 5) {
            let closes = deciding || leaderUpASet
            return GameMoment(symbol: "tennisball.fill", emoji: "🎾",
                              headline: closes ? "\(leaderName) is a game from winning the match" : "\(leaderName) is a game from winning the set",
                              detail: score, mustSee: closes)
        }
        if deciding {
            return GameMoment(symbol: "tennisball.fill", emoji: "🎾",
                              headline: ga == gb ? "Deciding set, all square at \(ga)-\(gb)" : "Deciding set: \(leaderName) leads \(top)-\(low)",
                              detail: score, mustSee: ga + gb >= 7)
        }
        return GameMoment(symbol: "tennisball.fill", emoji: "🎾",
                          headline: ga == gb ? "Set \(cur + 1) level at \(ga)-\(gb)" : "\(leaderName) leads set \(cur + 1), \(top)-\(low)", detail: score)
    }

    private var football: GameMoment? {
        let redZone = raw["isRedZone"] as? Bool == true
        let down = raw["downDistanceText"] as? String ?? raw["shortDownDistanceText"] as? String
        if redZone {
            return GameMoment(symbol: "football.fill", emoji: "🏈", headline: "In the red zone. Touchdown chance",
                              detail: [down, scoreLine].compactMap { $0 }.joined(separator: ", "), mustSee: true)
        }
        if period >= 4, let s = clockSeconds, s <= 120, let d = diff, d <= 8 {
            return GameMoment(symbol: "football.fill", emoji: "🏈", headline: "Final two minutes, one-score game", detail: scoreLine, mustSee: true)
        }
        return down.map { GameMoment(symbol: "football.fill", emoji: "🏈", headline: $0, detail: scoreLine) }
    }

    private var basketball: GameMoment? {
        if period > 4 { return GameMoment(symbol: "basketball.fill", emoji: "🏀", headline: "Overtime", detail: scoreLine, mustSee: true) }
        if let p = lastPlay, p.localizedCaseInsensitiveContains("free throw") {
            return GameMoment(symbol: "basketball.fill", emoji: "🏀", headline: "At the free-throw line", detail: p)
        }
        if period == 4, let s = clockSeconds, s <= 120, let d = diff, d <= 5 {
            return GameMoment(symbol: "basketball.fill", emoji: "🏀",
                              headline: d == 0 ? "Tied with \(clock ?? "") left" : "Clutch time: \(leader ?? "") up \(d), \(clock ?? "") left",
                              detail: scoreLine, mustSee: true)
        }
        return nil
    }

    private var baseball: GameMoment? {
        let second = raw["onSecond"] as? Bool == true, third = raw["onThird"] as? Bool == true
        let outs = (raw["outs"] as? NSNumber)?.intValue
        if period >= 9, let d = diff, d <= 1 {
            return GameMoment(symbol: "baseball.fill", emoji: "⚾", headline: d == 0 ? "Tied in the \(period.ordinal)" : "\(period.ordinal) inning, one-run game",
                              detail: scoreLine, mustSee: true)
        }
        if second || third {
            return GameMoment(symbol: "baseball.fill", emoji: "⚾", headline: "Runners in scoring position\(outs.map { ", \($0) out\($0 == 1 ? "" : "s")" } ?? "")",
                              detail: scoreLine)
        }
        return nil
    }

    private var hockey: GameMoment? {
        if period > 3 { return GameMoment(symbol: "hockey.puck.fill", emoji: "🏒", headline: "Overtime. Next goal wins", detail: scoreLine, mustSee: true) }
        if raw["isPowerPlay"] as? Bool == true || raw["powerPlay"] as? Bool == true {
            return GameMoment(symbol: "hockey.puck.fill", emoji: "🏒", headline: "Power play. Goal chance", detail: scoreLine)
        }
        if period == 3, let s = clockSeconds, s <= 300, let d = diff, d <= 1 {
            return GameMoment(symbol: "hockey.puck.fill", emoji: "🏒", headline: d == 0 ? "Tied, final five minutes" : "One-goal game, final five minutes",
                              detail: scoreLine, mustSee: true)
        }
        return nil
    }

    private var soccer: GameMoment? {
        if let p = lastPlay?.lowercased() {
            if p.contains("penalty") { return GameMoment(symbol: "soccerball", emoji: "⚽", headline: "Penalty!", detail: lastPlay, mustSee: true) }
            if p.contains("red card") { return GameMoment(symbol: "soccerball", emoji: "⚽", headline: "Red card", detail: lastPlay, mustSee: true) }
            if p.contains("corner") { return GameMoment(symbol: "soccerball", emoji: "⚽", headline: "Corner kick", detail: lastPlay) }
        }
        let minute = Int((clock ?? "").prefix { $0.isNumber }) ?? 0
        if minute >= 80, let d = diff, d <= 1 {
            return GameMoment(symbol: "soccerball", emoji: "⚽", headline: d == 0 ? "Level with \(90 - min(minute, 90))' left" : "One-goal game, final minutes",
                              detail: scoreLine, mustSee: true)
        }
        return nil
    }
}

// MARK: - What X is talking about

extension XPulse {
    /// Phrases that mean "you'll want to see this". Ending-type phrases make it a must-see.
    private static let phrases: [(String, Bool)] = [
        ("match point", true), ("set point", true), ("championship point", true), ("tiebreak", true), ("tie-break", true),
        ("overtime", true), ("sudden death", true), ("shootout", true), ("penalties", true), ("extra time", true),
        ("buzzer beater", true), ("game 7", true), ("walk-off", true), ("walkoff", true), ("final seconds", true),
        ("break point", false), ("free throws", false), ("red card", false), ("penalty", false), ("corner", false),
        ("comeback", false), ("upset", false), ("hat trick", false), ("injury", false), ("power play", false),
        // Concerts and shows: surprise guests and big moments on stage.
        ("surprise guest", true), ("special guest", true), ("brought out", true), ("on stage now", true),
        ("encore", false), ("setlist", false),
    ]

    /// The most-mentioned phrase in the last 10 minutes of posts, if at least two posts use it.
    var buzzPhrase: (phrase: String, posts: Int, mustSee: Bool)? {
        let recent = posts.filter { Date().timeIntervalSince($0.date) <= 600 }.map { $0.text.lowercased() }
        let counts = Self.phrases.map { p in (p.0, recent.filter { $0.contains(p.0) }.count, p.1) }
        guard let best = counts.max(by: { $0.1 < $1.1 }), best.1 >= 2 else { return nil }
        return (best.0, best.1, best.2)
    }
}

extension String {
    var lastName: String { split(separator: " ").last.map(String.init) ?? self }
}

extension Int {
    var ordinal: String {
        let suffix = (11...13).contains(self % 100) ? "th" : [1: "st", 2: "nd", 3: "rd"][self % 10] ?? "th"
        return "\(self)\(suffix)"
    }
}
