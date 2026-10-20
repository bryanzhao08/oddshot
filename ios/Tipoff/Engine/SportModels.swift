import Foundation

/// In-game models trained in ml/sports/ (gradient-boosted trees, run on the phone):
///  - soccer: chance a team scores in the next 10 minutes
///  - football: chance the current drive ends in a touchdown (and in any score)
///  - basketball: chance of a lead change or tie in the next 3 game minutes
/// Features are built from ESPN's live feeds exactly as in ml/sports/README.md.
final class SportModel: @unchecked Sendable {   // immutable after load
    let sport: String
    let features: [String]
    let ensembles: [String: (TreeEnsemble, Calibration)]
    let baseRate: [String: Double]

    private init(sport: String, features: [String], ensembles: [String: (TreeEnsemble, Calibration)], baseRate: [String: Double]) {
        self.sport = sport; self.features = features; self.ensembles = ensembles; self.baseRate = baseRate
    }

    private struct Raw: Decodable {
        var sport: String
        var features: [String]
        var models: [String: RawEnsemble]
        var metrics: [String: AnyDecodable]?
    }

    static func load(data: Data) -> SportModel? {
        guard let raw = try? JSONDecoder().decode(Raw.self, from: data) else { return nil }
        var ens: [String: (TreeEnsemble, Calibration)] = [:]
        for (name, r) in raw.models {
            guard let e = TreeEnsemble(r, nFeatures: raw.features.count) else { return nil }
            ens[name] = (e, Calibration(r.calibration))
        }
        // Base rates let the app say "3× more likely than usual". Accepts base_rate or base_rate_<model>.
        var base: [String: Double] = [:]
        for name in raw.models.keys {
            base[name] = raw.metrics?["base_rate_\(name)"]?.double ?? raw.metrics?["base_rate"]?.double ?? raw.metrics?[name]?.dict?["base_rate"]
        }
        return SportModel(sport: raw.sport, features: raw.features, ensembles: ens, baseRate: base)
    }

    static func bundled(_ name: String) -> SportModel? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "sports")
                ?? Bundle.main.url(forResource: name, withExtension: "json"), let d = try? Data(contentsOf: url) else { return nil }
        return load(data: d)
    }

    /// Calibrated probability for each model, from a feature dictionary (missing → NaN).
    func predict(_ f: [String: Double]) -> [String: Double] {
        let x = features.map { f[$0] ?? .nan }
        return x.withUnsafeBufferPointer { buf in
            ensembles.mapValues { e, cal in cal.apply(1 / (1 + exp(-e.margin(buf, contrib: nil)))) }
        }
    }
}

/// Tiny JSON value for the free-form metrics block.
struct AnyDecodable: Decodable {
    let value: Any
    var double: Double? { (value as? Double) ?? (value as? Int).map(Double.init) }
    var dict: [String: Double]? { (value as? [String: Any])?.compactMapValues { ($0 as? Double) ?? ($0 as? Int).map(Double.init) } }
    init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if let v = try? c.decode(Double.self) { value = v }
        else if let v = try? c.decode(String.self) { value = v }
        else if let v = try? c.decode(Bool.self) { value = v }
        else if let v = try? c.decode([String: AnyDecodable].self) { value = v.mapValues(\.value) }
        else if let v = try? c.decode([AnyDecodable].self) { value = v.map(\.value) }
        else { value = NSNull() }
    }
}

// MARK: - Soccer (mirrors ml/sports/soccer_data.py)

struct SoccerEvent: Sendable, Hashable, Codable {
    enum Kind: String, Sendable, Codable { case shot, shot_on_target, corner, goal, red }
    var min: Double
    var team: String          // "home" | "away"
    var kind: Kind            // one record per event; a goal also counts as a shot and a shot on target
    var zone: String? = nil   // shots: "close" | "box" | "out" (from the commentary wording)
}

enum SoccerFeatures {
    private static func norm(_ s: String) -> String {
        s.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
    }

    private static func firstMatch(_ pattern: String, in s: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), m.numberOfRanges > 1,
              let r = Range(m.range(at: 1), in: s) else { return nil }
        return String(s[r])
    }

    private static func parens(_ s: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: #"\(([^)]+)\)"#) else { return [] }
        return re.matches(in: s, range: NSRange(s.startIndex..., in: s)).compactMap { Range($0.range(at: 1), in: s).map { String(s[$0]) } }
    }

    static func shotZone(_ text: String) -> String {
        let t = text.lowercased()
        if t.contains("very close range") || t.contains("six yard box") { return "close" }
        if t.contains("centre of the box") || t.contains("side of the box") { return "box" }
        return "out"
    }

    /// ESPN summary → normalized timeline.
    static func timeline(summary: [String: Any]) -> [SoccerEvent] {
        let comps = ((summary["header"] as? [String: Any])?["competitions"] as? [[String: Any]])?.first?["competitors"] as? [[String: Any]] ?? []
        var names: [String: String] = [:]   // normalized name → side
        for c in comps {
            if let side = c["homeAway"] as? String, ["home", "away"].contains(side),
               let n = (c["team"] as? [String: Any])?["displayName"] as? String { names[norm(n)] = side }
        }
        guard names.count == 2 else { return [] }
        func match(_ n: String?) -> String? { n.flatMap { names[norm($0)] } }
        var out: [SoccerEvent] = []
        var seen = Set<String>()
        for item in summary["commentary"] as? [[String: Any]] ?? [] {
            let play = item["play"] as? [String: Any] ?? [:]
            let typ = (((play["type"] as? [String: Any])?["text"] as? String) ?? "").trimmingCharacters(in: .whitespaces).lowercased()
            let kind: SoccerEvent.Kind, own: Bool
            if typ.hasPrefix("own goal") { kind = .goal; own = true }
            else if typ.hasPrefix("goal") || typ.hasPrefix("penalty - scored") { kind = .goal; own = false }
            else if typ.hasPrefix("shot on target") || typ.hasPrefix("saved") { kind = .shot_on_target; own = false }
            else if typ.hasPrefix("shot") { kind = .shot; own = false }
            else if typ.hasPrefix("corner awarded") { kind = .corner; own = false }
            else if typ.contains("red card") { kind = .red; own = false }
            else { continue }
            guard let secs = ((item["time"] as? [String: Any])?["value"] as? NSNumber)?.doubleValue, secs >= 0 else { continue }
            let minute = secs / 60
            let playId = (play["id"] as? String) ?? (play["id"] as? NSNumber)?.stringValue
            if let id = playId, seen.contains(id) { continue }
            let body = (item["text"] as? String) ?? (play["text"] as? String) ?? ""
            let playTeam = (play["team"] as? [String: Any])?["displayName"] as? String
            var side: String?
            if kind == .corner {
                // play.team on corners is the side that conceded it; the text names who won it.
                side = match(firstMatch(#"\bCorner,\s*(.+?)\s*\."#, in: body))
                if side == nil { continue }
            }
            if own {
                side = match(playTeam)
                if side == nil, let conceder = match(firstMatch(#"Own Goal by .+?,\s*(.+?)\."#, in: body)) {
                    side = conceder == "home" ? "away" : "home"
                }
            }
            if side == nil && kind == .goal && !own { side = parens(body).lazy.compactMap(match).first }
            if side == nil { side = match(playTeam) }
            if side == nil { side = parens(body).lazy.compactMap(match).first }
            guard let side else { continue }
            if let id = playId { seen.insert(id) }
            let isShot = [.shot, .shot_on_target, .goal].contains(kind) && !own
            out.append(.init(min: minute, team: side, kind: kind, zone: isShot ? shotZone(body) : nil))
        }
        return out.enumerated().sorted { ($0.element.min, $0.offset) < ($1.element.min, $1.offset) }.map(\.element)
    }

    /// Feature dict for `team` at minute `t` (soccer_data.features).
    static func features(_ tl: [SoccerEvent], team us: String, at t: Double) -> [String: Double] {
        let them = us == "home" ? "away" : "home"
        let past = tl.filter { $0.min <= t }
        func count(_ side: String, _ kind: SoccerEvent.Kind, window: Double? = nil) -> Double {
            Double(past.filter { e in
                e.team == side
                    && (e.kind == kind || (kind == .shot && (e.kind == .shot_on_target || e.kind == .goal)) || (kind == .shot_on_target && e.kind == .goal))
                    && (window.map { e.min > t - $0 } ?? true)
            }.count)
        }
        let goals = past.filter { $0.kind == .goal }.map(\.min)
        let ourShots = past.filter { $0.team == us && [.shot, .shot_on_target, .goal].contains($0.kind) }.map(\.min)
        let gu = count(us, .goal), gt = count(them, .goal)
        return [
            "minute": t, "is_home": us == "home" ? 1 : 0, "goal_diff": gu - gt, "goals_us": gu, "goals_them": gt,
            "red_us": count(us, .red), "red_them": count(them, .red),
            "shots_us": count(us, .shot), "shots_them": count(them, .shot),
            "sot_us": count(us, .shot_on_target), "sot_them": count(them, .shot_on_target),
            "corners_us": count(us, .corner), "corners_them": count(them, .corner),
            "shots_us_10": count(us, .shot, window: 10), "shots_them_10": count(them, .shot, window: 10),
            "sot_us_10": count(us, .shot_on_target, window: 10), "sot_them_10": count(them, .shot_on_target, window: 10),
            "corners_us_10": count(us, .corner, window: 10), "corners_them_10": count(them, .corner, window: 10),
            "shots_us_5": count(us, .shot, window: 5), "sot_us_5": count(us, .shot_on_target, window: 5),
            "corners_us_5": count(us, .corner, window: 5),
            "mins_since_goal": goals.max().map { t - $0 } ?? t, "mins_since_our_shot": ourShots.max().map { t - $0 } ?? t,
            "second_half": t > 45 ? 1 : 0,
            "box_shots_us_10": zones(past, us, ["box", "close"], t, 10), "box_shots_them_10": zones(past, them, ["box", "close"], t, 10),
            "close_shots_us_10": zones(past, us, ["close"], t, 10),
            "box_shots_us": zones(past, us, ["box", "close"], t, nil), "box_shots_them": zones(past, them, ["box", "close"], t, nil),
        ]
    }

    private static func zones(_ past: [SoccerEvent], _ side: String, _ z: Set<String>, _ t: Double, _ window: Double?) -> Double {
        Double(past.filter { e in e.team == side && e.zone.map(z.contains) == true && (window.map { e.min > t - $0 } ?? true) }.count)
    }
}

// MARK: - Football

enum FootballFeatures {
    /// From ESPN's scoreboard situation. Returns nil when there's no possession (kickoffs, breaks).
    static func features(_ g: LiveGame) -> (features: [String: Double], offense: Int)? {
        let s = g.raw
        guard let posId = (s["possession"] as? String) ?? (s["possession"] as? NSNumber)?.stringValue,
              let off = g.teamIds.firstIndex(of: posId),
              let down = (s["down"] as? NSNumber)?.doubleValue, (1...4).contains(down) else { return nil }
        let dist = (s["distance"] as? NSNumber)?.doubleValue ?? .nan
        // "KC 35": own side → 100 − 35 to go, opponent side → 35 to go.
        var yl100 = Double.nan
        if let pt = s["possessionText"] as? String {
            let parts = pt.split(separator: " ")
            if parts.count == 2, let n = Double(parts[1]) {
                yl100 = String(parts[0]) == g.abbrs[off] ? 100 - n : n
            } else if pt.contains("50") { yl100 = 50 }
        }
        guard !yl100.isNaN else { return nil }
        let goal = ((s["downDistanceText"] as? String) ?? "").localizedCaseInsensitiveContains("goal") || dist >= yl100
        let q = Double(g.period)
        let clock = Double(g.clockSeconds ?? 0)
        let half = q <= 4 ? clock + ((q == 1 || q == 3) ? 900 : 0) : clock
        let game = q <= 4 ? clock + (4 - q) * 900 : clock
        let diff: Double = {
            guard let a = g.scores[off], let b = g.scores[1 - off] else { return .nan }
            return Double(a - b)
        }()
        let to = [(s["homeTimeouts"] as? NSNumber)?.doubleValue ?? .nan, (s["awayTimeouts"] as? NSNumber)?.doubleValue ?? .nan]
        return ([
            "yardline_100": yl100, "down": down, "ydstogo": dist, "goal_to_go": goal ? 1 : 0, "qtr": min(q, 5),
            "half_seconds_remaining": half, "game_seconds_remaining": game, "score_differential": diff,
            "posteam_timeouts_remaining": to[off], "defteam_timeouts_remaining": to[1 - off],
        ], off)
    }
}

// MARK: - Basketball (mirrors ml/sports/basketball_data.py)

struct ScorePoint: Sendable, Hashable, Codable { var sec: Double; var home: Int; var away: Int }

enum BasketballFeatures {
    static func elapsed(period: Int, clock: String) -> Double? {
        let p = clock.split(separator: ":").compactMap { Double($0) }
        guard let left = p.count == 2 ? p[0] * 60 + p[1] : p.first else { return nil }
        let length: Double = period <= 4 ? 720 : 300
        guard period >= 1, (0...length).contains(left) else { return nil }
        return (period <= 4 ? Double(period - 1) * 720 : 2880 + Double(period - 5) * 300) + (length - left)
    }

    /// ESPN summary plays → score-changing timeline (drops repeats and malformed reversals).
    static func timeline(summary: [String: Any]) -> [ScorePoint] {
        var out: [ScorePoint] = []
        var prev = (0, 0)
        for p in summary["plays"] as? [[String: Any]] ?? [] {
            guard p["scoringPlay"] as? Bool == true,
                  let per = ((p["period"] as? [String: Any])?["number"] as? NSNumber)?.intValue,
                  let clock = (p["clock"] as? [String: Any])?["displayValue"] as? String,
                  let sec = elapsed(period: per, clock: clock),
                  let h = (p["homeScore"] as? NSNumber)?.intValue ?? Int(p["homeScore"] as? String ?? ""),
                  let a = (p["awayScore"] as? NSNumber)?.intValue ?? Int(p["awayScore"] as? String ?? "") else { continue }
            if (h, a) == prev || h < prev.0 || a < prev.1 { continue }
            out.append(ScorePoint(sec: (sec * 100).rounded() / 100, home: h, away: a))
            prev = (h, a)
        }
        return out.enumerated().sorted { ($0.element.sec, $0.offset) < ($1.element.sec, $1.offset) }.map(\.element)
    }

    private static func scores(_ tl: [ScorePoint], at: Double) -> (Int, Int) {
        var s = (0, 0)
        for e in tl { if e.sec > at { break }; s = (e.home, e.away) }
        return s
    }

    /// Leader-perspective features at game second `at` (basketball_data.features_at). Nil when tied.
    static func features(_ tl: [ScorePoint], at: Double) -> [String: Double]? {
        let (home, away) = scores(tl, at: at)
        guard home != away else { return nil }
        let lh = home > away
        let p2 = scores(tl, at: at - 120), p5 = scores(tl, at: at - 300)
        let (l2, t2) = lh ? (home - p2.0, away - p2.1) : (away - p2.1, home - p2.0)
        let (l5, t5) = lh ? (home - p5.0, away - p5.1) : (away - p5.1, home - p5.0)
        var run = 0, ph = 0, pa = 0
        for e in tl {
            if e.sec > at { break }
            let dl = lh ? e.home - ph : e.away - pa, dt = lh ? e.away - pa : e.home - ph
            if dl != 0 { run = 0 }
            run += dt
            ph = e.home; pa = e.away
        }
        let a = Int(at)
        let period = a < 2880 ? a / 720 + 1 : 5 + (a - 2880) / 300
        let left = a < 2880 ? 720 - a % 720 : 300 - (a - 2880) % 300
        return [
            "period": Double(period), "sec_left_regulation": 2880 - at, "sec_left_period": Double(left),
            "lead": Double(abs(home - away)), "pts_leader_2m": Double(l2), "pts_trailer_2m": Double(t2),
            "pts_leader_5m": Double(l5), "pts_trailer_5m": Double(t5), "run_trailer": Double(run),
            "total_points": Double(home + away),
        ]
    }
}

// MARK: - Turning predictions into moments

enum SportModels {
    nonisolated(unsafe) private static var cache: [String: SportModel?] = [:]
    private static let lock = NSLock()

    /// For tests/replays: use a model loaded from elsewhere.
    static func install(_ m: SportModel, for sport: String) {
        lock.lock(); cache[sport] = m; lock.unlock()
    }

    static func model(_ sport: String) -> SportModel? {
        lock.lock(); defer { lock.unlock() }
        if let m = cache[sport] { return m }
        let m = SportModel.bundled(sport)
        cache[sport] = m
        return m
    }

    // Thresholds from the held-out test games (ml/sports/REPORT.md):
    //  soccer  ≥ 22% → shown (goal follows 24% of the time vs 15% normally), ≥ 33% must-see
    //  football TD ≥ 42% → shown (58% come true), ≥ 60% must-see (72%)
    //  basketball ≥ 50% → shown (67% come true), ≥ 60% in the 4th or later must-see (71%)

    private static func usually(_ model: SportModel, _ key: String) -> String {
        model.baseRate[key].map { "usually \(pct($0))" } ?? ""
    }

    static func soccer(_ g: LiveGame, summary: [String: Any]) -> GameMoment? {
        guard let model = model("soccer") else { return nil }
        let tl = SoccerFeatures.timeline(summary: summary)
        // Whole match minutes, as in training (1…88).
        let t = Double(g.minute ?? Int(tl.map(\.min).max() ?? 0))
        guard (1...88).contains(t) else { return nil }
        let preds = [0, 1].map { i -> (Int, Double) in
            (i, model.predict(SoccerFeatures.features(tl, team: i == 0 ? "home" : "away", at: t))["goal_next_10m"] ?? 0)
        }
        guard let (i, p) = preds.max(by: { $0.1 < $1.1 }), p >= 0.22 else { return nil }
        return GameMoment(symbol: "soccerball", emoji: "⚽",
                          headline: "\(g.names[i]) pressing: \(pct(p)) chance of a goal in the next 10 min",
                          detail: [usually(model, "goal_next_10m"), g.scoreLine].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ". "),
                          mustSee: p >= 0.33)
    }

    static func football(_ g: LiveGame) -> GameMoment? {
        guard let model = model("football"), let (f, off) = FootballFeatures.features(g) else { return nil }
        let p = model.predict(f)
        guard let td = p["td_drive"], td >= 0.42 else { return nil }
        return GameMoment(symbol: "football.fill", emoji: "🏈",
                          headline: "\(g.names[off]) drive: \(pct(td)) chance of a touchdown",
                          detail: [p["score_drive"].map { "\(pct($0)) chance of points" }, g.scoreLine].compactMap { $0 }.joined(separator: ". "),
                          mustSee: td >= 0.6)
    }

    static func basketball(_ g: LiveGame, summary: [String: Any]) -> GameMoment? {
        guard let model = model("basketball") else { return nil }
        let tl = BasketballFeatures.timeline(summary: summary)
        guard let clock = g.clock, let t = BasketballFeatures.elapsed(period: g.period, clock: clock),
              let f = BasketballFeatures.features(tl, at: t.rounded(.down)),
              let p = model.predict(f)["lead_change_3m"], p >= 0.5 else { return nil }
        let trailer = (g.scores[0] ?? 0) > (g.scores[1] ?? 0) ? g.names[1] : g.names[0]
        return GameMoment(symbol: "basketball.fill", emoji: "🏀",
                          headline: "\(pct(p)) chance \(trailer) ties it or takes the lead in the next 3 min",
                          detail: g.scoreLine, mustSee: p >= 0.6 && g.period >= 4)
    }

    private static func pct(_ p: Double) -> String { "\(Int((p * 100).rounded()))%" }
}
