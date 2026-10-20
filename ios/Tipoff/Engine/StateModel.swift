import Foundation

/// Reads what's happening in a game from how its odds move (ml/state/). It's not a prediction:
/// "Goal for Spurs?", "Bills driving", "Break in play". Trained on 3,122 games of minute-by-minute
/// Polymarket prices labelled with ESPN play-by-play. Odds only, so it also works where ESPN has nothing.
/// Feature code mirrors ml/state/features.py line for line (checked by parity fixtures).
final class StateModel: @unchecked Sendable {   // immutable after load
    let features: [String]
    let classes: [String]
    let sports: [String]
    let kalman: (ql: Double, qv: Double, r: Double)
    private let ensembles: [TreeEnsemble]

    private struct Raw: Decodable {
        var features: [String]
        var classes: [String]
        var sports: [String]
        var kalman: [String: Double]
        var models: [String: RawEnsemble]
    }

    private init(features: [String], classes: [String], sports: [String], kalman: (Double, Double, Double), ensembles: [TreeEnsemble]) {
        self.features = features; self.classes = classes; self.sports = sports; self.kalman = kalman; self.ensembles = ensembles
    }

    static func load(data: Data) -> StateModel? {
        guard let r = try? JSONDecoder().decode(Raw.self, from: data) else { return nil }
        var ens: [TreeEnsemble] = []
        for c in r.classes {
            guard let raw = r.models[c], let e = TreeEnsemble(raw, nFeatures: r.features.count) else { return nil }
            ens.append(e)
        }
        guard let ql = r.kalman["q_level"], let qv = r.kalman["q_velocity"], let rr = r.kalman["r"] else { return nil }
        return StateModel(features: r.features, classes: r.classes, sports: r.sports, kalman: (ql, qv, rr), ensembles: ens)
    }

    static let shared: StateModel? = {
        guard let url = Bundle.main.url(forResource: "state", withExtension: "json", subdirectory: "state")
                ?? Bundle.main.url(forResource: "state", withExtension: "json"),
              let d = try? Data(contentsOf: url) else { return nil }
        return load(data: d)
    }()

    /// Class probabilities from a feature dict.
    func predict(_ f: [String: Double]) -> [String: Double] {
        let x = features.map { f[$0] ?? .nan }
        let margins = x.withUnsafeBufferPointer { buf in ensembles.map { $0.margin(buf, contrib: nil) } }
        let top = margins.max() ?? 0
        let e = margins.map { exp($0 - top) }
        let s = e.reduce(0, +)
        return Dictionary(uniqueKeysWithValues: zip(classes, e.map { $0 / s }))
    }

    // MARK: features (ml/state/features.py)

    /// Last observation at or before each minute boundary, in points (0-100).
    static func grid(_ prices: [(t: Int, p: Double)], start: Int, minutes n: Int) -> [Double?] {
        var out: [Double?] = []
        out.reserveCapacity(n + 1)
        var j = -1
        for m in 0...n {
            let g = start + 60 * m
            while j + 1 < prices.count && prices[j + 1].t <= g { j += 1 }
            out.append(j >= 0 ? prices[j].p * 100 : nil)
        }
        return out
    }

    typealias KF = (level: Double, vel: Double, sdLevel: Double, sdVel: Double, innov: Double, z: Double)

    func kalmanFilter(_ series: [Double?]) -> [KF?] {
        let (ql, qv, r) = kalman
        var out: [KF?] = []
        var x0: Double? = nil, x1 = 0.0
        var p00 = 0.0, p01 = 0.0, p11 = 0.0
        for z in series {
            guard var lvl = x0 else {
                guard let z else { out.append(nil); continue }
                x0 = z; x1 = 0; p00 = r; p01 = 0; p11 = 1
                out.append((z, 0, p00.squareRoot(), p11.squareRoot(), 0, 0))
                continue
            }
            lvl = lvl + x1
            let n00 = p00 + 2.0 * p01 + p11 + ql, n01 = p01 + p11, n11 = p11 + qv
            p00 = n00; p01 = n01; p11 = n11
            var innov = 0.0, zs = 0.0
            if let z {
                innov = z - lvl
                let s = p00 + r
                let k0 = p00 / s, k1 = p01 / s
                lvl = lvl + k0 * innov
                x1 = x1 + k1 * innov
                let m00 = (1.0 - k0) * p00, m01 = (1.0 - k0) * p01, m11 = p11 - k1 * p01
                p00 = m00; p01 = m01; p11 = m11
                zs = innov / s.squareRoot()
            }
            x0 = lvl
            out.append((lvl, x1, max(p00, 0).squareRoot(), max(p11, 0).squareRoot(), innov, zs))
        }
        return out
    }

    private static func std(_ xs: [Double]) -> Double {
        guard xs.count >= 2 else { return .nan }
        var s = 0.0
        for x in xs { s += x }
        let m = s / Double(xs.count)
        var q = 0.0
        for x in xs { q += (x - m) * (x - m) }
        return (q / Double(xs.count)).squareRoot()
    }

    func featuresFromGrid(_ g: [Double?], _ kf: [KF?], minute m: Int, sport: String, threeWay: Bool) -> [String: Double]? {
        guard m < g.count, let p = g[m] else { return nil }
        func at(_ k: Int) -> Double? { (k >= 0 && k <= m) ? g[k] : nil }
        func ret(_ lag: Int) -> Double { at(m - lag).map { p - $0 } ?? .nan }
        var diffs: [(k: Int, d: Double)] = []
        for k in max(1, m - 29)...max(m, 1) where k <= m {
            if let a = at(k), let b = at(k - 1) { diffs.append((k, a - b)) }
        }
        func vol(_ w: Int) -> Double { Self.std(diffs.filter { $0.k > m - w }.map(\.d)) }
        let jumps = diffs.filter { $0.k > m - 5 }.map { abs($0.d) }
        var lastSign = 0.0, run = 0
        for (_, d) in diffs.reversed() {
            let s: Double = d > 1e-9 ? 1 : d < -1e-9 ? -1 : 0
            if s == 0 { continue }
            if lastSign == 0 { lastSign = s }
            if s != lastSign { break }
            run += 1
        }
        let k: KF = kf[m] ?? (p, 0, .nan, .nan, 0, 0)
        var f: [String: Double] = [
            "p": p, "dist_mid": abs(p - 50),
            "ret_1": ret(1), "ret_2": ret(2), "ret_3": ret(3), "ret_5": ret(5), "ret_10": ret(10), "ret_20": ret(20),
            "absret_1": abs(ret(1)), "absret_3": abs(ret(3)), "absret_10": abs(ret(10)),
            "vol_5": vol(5), "vol_15": vol(15), "vol_30": vol(30),
            "maxjump_5": jumps.max() ?? .nan, "last_sign": lastSign, "run_len": Double(run),
            "kf_level": k.level, "kf_vel": k.vel, "kf_sd_level": k.sdLevel, "kf_sd_vel": k.sdVel, "kf_innov": k.innov, "kf_z": k.z,
            "minute": Double(m), "three_way": threeWay ? 1 : 0,
        ]
        for s in sports { f["sport_\(s)"] = sport == s ? 1 : 0 }
        return f
    }

    /// Probabilities for the current minute of a game, from its raw price history.
    func read(prices: [PricePoint], gameStart: Date, now: Date, sport: String) -> [String: Double]? {
        let start = Int(gameStart.timeIntervalSince1970) / 60 * 60
        let minute = (Int(now.timeIntervalSince1970) - start) / 60
        guard minute >= 0, minute <= 300 else { return nil }
        let pts = prices.sorted { $0.t < $1.t }.map { (t: Int($0.t.timeIntervalSince1970), p: $0.p) }
        let g = Self.grid(pts, start: start, minutes: minute)
        guard let f = featuresFromGrid(g, kalmanFilter(g), minute: minute, sport: sport, threeWay: sport == "soccer") else { return nil }
        return predict(f)
    }
}

// MARK: - From probabilities to plain words

extension StateModel {
    /// Sport code the model knows, from the Polymarket event slug ("nhl-bos-van-2026-10-19") or ESPN league.
    static func sport(of m: Market, espn: LiveGame? = nil) -> String? {
        if let g = espn {
            switch (g.sport, g.league) {
            case ("football", "college-football"): return "cfb"
            case ("football", _): return "nfl"
            case ("baseball", _): return "mlb"
            case ("hockey", _): return "nhl"
            case ("basketball", "nba"): return "nba"
            case ("soccer", _): return "soccer"
            default: break
            }
        }
        let slug = m.url?.lastPathComponent.lowercased() ?? ""
        let prefix = slug.split(separator: "-").first.map(String.init) ?? ""
        switch prefix {
        case "nfl": return "nfl"
        case "cfb": return "cfb"
        case "mlb": return "mlb"
        case "nhl": return "nhl"
        case "nba": return "nba"
        case "epl", "lal", "ucl", "uel", "mls", "bun", "sea", "fl1", "ere", "por", "bra", "arg", "mex", "elc", "spl", "tur": return "soccer"
        default: return nil
        }
    }

    /// What to say, if the model is sure enough (≥ 60%, where it's right ~75% of the time on held-out games).
    func moment(for m: Market, history: [PricePoint], sport: String, now: Date = .now) -> GameMoment? {
        guard m.live, let start = m.startTime, let probs = read(prices: history, gameStart: start, now: now, sport: sport),
              let (cls, p) = probs.max(by: { $0.value < $1.value }), p >= 0.6 else { return nil }
        let us = m.sideLabel
        let them = m.otherOutcome.flatMap { $0.lowercased() == "no" ? nil : $0 } ?? "the other side"
        let sure = "\(Int((p * 100).rounded()))% sure, from how the odds are moving"
        let (sym, emoji): (String, String) = {
            switch sport {
            case "soccer": return ("soccerball", "⚽")
            case "nhl": return ("hockey.puck.fill", "🏒")
            case "mlb": return ("baseball.fill", "⚾")
            case "nba": return ("basketball.fill", "🏀")
            default: return ("football.fill", "🏈")
            }
        }()
        func scored(_ who: String) -> String {
            switch sport {
            case "soccer", "nhl": return "Goal for \(who)?"
            case "mlb": return "\(who) just scored"
            case "nba": return "Big swing toward \(who)"
            default: return "Big play for \(who)"
            }
        }
        func pressure(_ who: String) -> String {
            switch sport {
            case "nhl": return "\(who) on the power play?"
            case "nfl", "cfb": return "\(who) driving"
            case "nba": return "\(who) on a run"
            case "soccer": return "\(who) on the attack"
            default: return "\(who) threatening"
            }
        }
        switch cls {
        case "big_moment_us": return GameMoment(symbol: sym, emoji: emoji, headline: scored(us), detail: sure, mustSee: p >= 0.75)
        case "big_moment_them": return GameMoment(symbol: sym, emoji: emoji, headline: scored(them), detail: sure, mustSee: p >= 0.75)
        case "big_moment": return GameMoment(symbol: "arrow.left.arrow.right", emoji: "🔄", headline: "The lead is changing hands", detail: sure, mustSee: p >= 0.75)
        case "pressure_us": return GameMoment(symbol: sym, emoji: emoji, headline: pressure(us), detail: sure)
        case "pressure_them": return GameMoment(symbol: sym, emoji: emoji, headline: pressure(them), detail: sure)
        case "break": return GameMoment(symbol: "pause.circle", emoji: "⏸️", headline: "Break in play", detail: sure)
        default: return nil   // calm: nothing worth saying
        }
    }
}
