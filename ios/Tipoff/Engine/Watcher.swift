import Foundation
import Observation

/// A notification we sent (shown in "Recent alerts").
struct Moment: Codable, Sendable, Identifiable, Hashable {
    enum Kind: String, Codable, Sendable { case headsUp, happening }
    var id: String
    var kind: Kind
    var title: String
    var body: String
    var date: Date
}

/// A market worth keeping an eye on, with the forecaster's take.
struct WatchItem: Identifiable, Hashable, Sendable {
    var market: Market
    var forecast: MoveForecast?
    var recent: [PricePoint]          // last hour, for the sparkline
    var moment: GameMoment?           // what's going on, in plain words
    var id: String { market.id }
    /// How far the odds could jump in the next 30 min (percentage points of probability).
    var expectedPts: Int { Int((forecast?.expectedMovePts ?? 0).rounded()) }
}

/// The whole engine, on the phone: poll Polymarket every 20 s, keep price history,
/// forecast the next 30 minutes, and send a local notification when something's up.
@MainActor @Observable
final class Watcher {
    static let shared = Watcher()

    var mode: Mode { didSet { UserDefaults.standard.set(mode.rawValue, forKey: "mode"); rerank() } }
    var onboarded: Bool { didSet { UserDefaults.standard.set(onboarded, forKey: "onboarded") } }
    /// Only alert about matches you follow.
    var onlyFollowed: Bool { didSet { UserDefaults.standard.set(onlyFollowed, forKey: "onlyFollowed") } }
    /// Matches you follow: match key (event title) → one of its market ids, so we can refetch it.
    private(set) var followed: [String: String] { didSet { UserDefaults.standard.set(followed, forKey: "followed") } }

    private(set) var items: [WatchItem] = []          // your mode's markets, biggest expected swing first
    private(set) var followedItems: [WatchItem] = []  // matches you follow, live first
    private(set) var moments: [Moment] = []
    private(set) var lastUpdate: Date?
    private(set) var offline = false
    /// Live X chatter about the top pick (only when an X token is set in Settings).
    private(set) var xPulse: XPulse?
    private(set) var xStatus: String?
    private(set) var xTopic: String?
    private var xMarketKey: String?
    private var lastXCheck: Date?

    private var markets: [String: Market] = [:]
    private var history: [String: [PricePoint]] = [:]
    private var forecasts: [String: MoveForecast] = [:]
    private var earlier: [String: MoveForecast] = [:]   // the same forecast as of 15 min ago
    private var backfilled: Set<String> = []
    private var games: [LiveGame] = []
    private var lastGamesFetch: Date?
    private var lastMustSee: [String: String] = [:]
    private var modelMoments: [String: GameMoment] = [:]   // ESPN game id → in-game model's take   // match → last must-see headline we sent
    private var lastAlert: [String: Date] = [:]
    private var lastAnyAlert: Date?
    private var model: ForecastModel?
    private var loop: Task<Void, Never>?
    private var ticking = false

    private init() {
        let d = UserDefaults.standard
        mode = Mode(rawValue: d.string(forKey: "mode") ?? "") ?? .sports
        onboarded = d.bool(forKey: "onboarded")
        onlyFollowed = d.bool(forKey: "onlyFollowed")
        followed = d.dictionary(forKey: "followed") as? [String: String] ?? [:]
        if let data = d.data(forKey: "moments") { moments = (try? JSONDecoder().decode([Moment].self, from: data)) ?? [] }
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    /// Poll → forecast → maybe notify. `background` keeps it short for iOS background refresh.
    func tick(background: Bool = false) async {
        guard !ticking else { return }
        ticking = true
        defer { ticking = false }
        if model == nil { model = await Task.detached { ForecastModel.bundled() }.value }

        guard var fetched = try? await Polymarket.topMarkets(limit: 300) else { offline = true; return }
        offline = false
        // Followed matches that fell out of the top 300 still get fresh prices.
        let have = Set(fetched.map(\.id))
        fetched += await Polymarket.markets(ids: followed.values.filter { !have.contains($0) })
        let now = Date()
        for m in fetched {
            markets[m.id] = m
            var h = (history[m.id] ?? []).filter { now.timeIntervalSince($0.t) < 6 * 3600 }
            h.append(PricePoint(t: now, p: m.probability))
            history[m.id] = h
        }
        let mine = fetched.filter(isFollowed)
        let relevant = mine + fetched.filter { mode.cares(about: $0) && !isFollowed($0) }
        await backfill(relevant, max: background ? 8 : 24)
        await forecast(Array(relevant.prefix(background ? 30 : 80)))
        if relevant.contains(where: { $0.category == .sports && $0.live }),
           lastGamesFetch.map({ now.timeIntervalSince($0) > 40 }) ?? true {
            lastGamesFetch = now
            games = await ESPN.liveGames()
            await runSportModels(relevant)
        }
        checkForAlerts(onlyFollowed ? mine : relevant, now: now)
        rerank()
        lastUpdate = now
        await checkX(now: now)
    }

    /// Every 2 minutes, look at what people on X are saying about the top pick.
    /// A sudden burst of posts is often the first sign something just happened.
    private func checkX(now: Date) async {
        // Your live followed match if you have one, otherwise the top pick.
        guard let top = (followedItems.first { $0.market.live } ?? items.first)?.market,
              Keychain.read("xBearerToken") != nil else { xPulse = nil; return }
        xTopic = top.split.name
        if let last = lastXCheck, now.timeIntervalSince(last) < 120, xPulse?.query == XFeed.query(for: top) { return }
        lastXCheck = now
        do {
            let pulse = try await XFeed.search(XFeed.query(for: top))
            xPulse = pulse
            xMarketKey = Self.key(top)
            xStatus = nil
            rerank()
            let key = top.eventTitle ?? top.id
            if pulse.isSpiking, lastAlert[key].map({ now.timeIntervalSince($0) >= 20 * 60 }) ?? true {
                alert(.headsUp, top, mode.xBuzz(top, surge: pulse.surge, phrase: pulse.buzzPhrase?.phrase), now)
            }
        } catch XFeed.Failure.unauthorized {
            xStatus = "X rejected the token. Check it in Settings."
        } catch XFeed.Failure.rateLimited {
            xStatus = "X rate limit reached. Trying again soon."
        } catch {
            xStatus = "Couldn't reach X."
        }
    }

    /// Clears the X feed right away after the token changes.
    func xTokenChanged() {
        lastXCheck = nil
        xPulse = nil
        xStatus = nil
        Task { await checkX(now: Date()) }
    }

    private func backfill(_ ms: [Market], max: Int) async {
        let todo = ms.filter { !backfilled.contains($0.id) && $0.tokenId != nil }.prefix(max)
        let results = await withTaskGroup(of: (String, [PricePoint]).self) { group in
            for m in todo { group.addTask { (m.id, await Polymarket.history(tokenId: m.tokenId!)) } }
            var out: [(String, [PricePoint])] = []
            for await r in group { out.append(r) }
            return out
        }
        for (id, pts) in results {
            backfilled.insert(id)
            let live = history[id] ?? []
            let cutoff = live.first?.t ?? .distantFuture
            history[id] = pts.filter { $0.t < cutoff } + live
        }
    }

    private func forecast(_ ms: [Market]) async {
        let model = self.model
        let inputs = ms.map { ($0.id, $0.forecastInput, history[$0.id] ?? []) }
        let (now, before) = await Task.detached(priority: .utility) {
            var now: [String: MoveForecast] = [:], before: [String: MoveForecast] = [:]
            let t = Date()
            for (id, m, h) in inputs {
                if let f = Forecaster.forecast(m, history: h, now: t, model: model) { now[id] = f }
                if let f = Forecaster.forecast(m, history: h, now: t.addingTimeInterval(-15 * 60), model: model),
                   f.historyMinutes >= 30 { before[id] = f }
            }
            return (now, before)
        }.value
        forecasts.merge(now) { $1 }
        earlier.merge(before) { $1 }
    }

    /// Two kinds of alerts, at most one per market per 20 min and one overall per 3 min:
    ///  ⚡ it just happened: a 10-min move bigger than this market normally makes
    ///  👀 heads-up: the odds of a big swing jumped compared with 15 minutes ago
    private func checkForAlerts(_ ms: [Market], now: Date) {
        if let last = lastAnyAlert, now.timeIntervalSince(last) < 180 { return }
        let quiet = { (m: Market) in self.lastAlert[m.eventTitle ?? m.id].map { now.timeIntervalSince($0) < 20 * 60 } ?? false }

        // 🎾 Must-see moments (tiebreak, match point, overtime...) beat everything, once per new moment.
        for m in ms where m.live {
            guard let mo = moment(for: m), mo.mustSee, lastMustSee[Self.key(m)] != mo.headline else { continue }
            lastMustSee[Self.key(m)] = mo.headline
            alert(.happening, m, ("\(mo.emoji) Must-see: \(mo.headline)", "\(m.split.name)\(mo.detail.map { ". \($0)" } ?? ""). \(mode.nudge)"), now)
            return
        }

        for m in ms where !quiet(m) {
            guard let h = history[m.id] else { continue }
            let window = h.filter { now.timeIntervalSince($0.t) <= 10 * 60 }
            guard let from = window.max(by: { abs(m.probability - $0.p) < abs(m.probability - $1.p) }) else { continue }
            let delta = m.probability - from.p
            let bar = max(0.06 * mode.pickiness, 0.45 * (forecasts[m.id]?.expectedMovePts ?? 0) / 100) * (isFollowed(m) ? 0.7 : 1)
            guard abs(delta) >= bar else { continue }
            let move = Self.describeMove(m, from: from.p, minutes: Int(now.timeIntervalSince(from.t) / 60))
            alert(.happening, m, mode.happening(m, move: move, moment: moment(for: m)), now)
            return
        }

        let heatingUp = ms.compactMap { m -> (Market, Double)? in
            let bar = min(0.35 * mode.pickiness, 0.9) * (isFollowed(m) ? 0.7 : 1)
            guard !quiet(m), let f = forecasts[m.id], let b = earlier[m.id],
                  f.pMove30 >= bar, b.pMove30 < bar * 0.7 else { return nil }
            return (m, f.pMove30)
        }
        if let (m, p) = heatingUp.max(by: { $0.1 < $1.1 }) {
            alert(.headsUp, m, mode.headsUp(m, chance: Int((p * 100).rounded()), moment: moment(for: m)), now)
        }
    }

    private func alert(_ kind: Moment.Kind, _ m: Market, _ copy: (title: String, body: String), _ now: Date) {
        lastAlert[m.eventTitle ?? m.id] = now
        lastAnyAlert = now
        post(Moment(id: "\(kind.rawValue)-\(m.id)-\(Int(now.timeIntervalSince1970))", kind: kind,
                    title: copy.title, body: copy.body, date: now))
    }

    private func post(_ moment: Moment) {
        var moment = moment
        moment.body = moment.body.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
        moments = Array(([moment] + moments).filter { Date().timeIntervalSince($0.date) < 12 * 3600 }.prefix(30))
        UserDefaults.standard.set(try? JSONEncoder().encode(moments), forKey: "moments")
        Notifier.post(moment)
    }

    private func rerank() {
        let now = Date()
        func item(_ m: Market) -> WatchItem {
            WatchItem(market: m, forecast: forecasts[m.id], recent: (history[m.id] ?? []).filter { now.timeIntervalSince($0.t) < 3600 },
                      moment: moment(for: m))
        }
        let bySwing: (WatchItem, WatchItem) -> Bool = { a, b in
            let sa = a.forecast?.expectedMovePts ?? 0, sb = b.forecast?.expectedMovePts ?? 0
            return sa != sb ? sa > sb : a.market.volume24h > b.market.volume24h
        }
        items = dedupe(markets.values.filter { mode.cares(about: $0) && !isFollowed($0) }.map(item).sorted(by: bySwing))
        // One row per followed match: its busiest market.
        followedItems = dedupe(markets.values.filter(isFollowed).sorted { $0.volume24h > $1.volume24h }.map(item))
            .sorted { ($0.market.live ? 1 : 0, $0.forecast?.expectedMovePts ?? 0) > ($1.market.live ? 1 : 0, $1.forecast?.expectedMovePts ?? 0) }
    }

    private func dedupe(_ xs: [WatchItem]) -> [WatchItem] {
        var seen = Set<String>()
        return xs.filter { seen.insert(Self.key($0.market)).inserted }
    }

    // MARK: explaining

    /// Runs the in-game models for live games you can see (soccer and basketball need play-by-play).
    private func runSportModels(_ ms: [Market]) async {
        var seen = Set<String>()
        let live = ms.filter(\.live).compactMap { ESPN.match($0, in: games) }.filter { seen.insert($0.id).inserted }.prefix(8)
        var out: [String: GameMoment] = [:]
        for g in live where g.sport == "football" { out[g.id] = SportModels.football(g) }
        let needSummary = live.filter { $0.sport == "soccer" || $0.sport == "basketball" }
        let results = await withTaskGroup(of: (String, GameMoment?).self) { group in
            for g in needSummary {
                group.addTask {
                    guard let sum = await ESPN.summary(g) else { return (g.id, nil) }
                    return (g.id, g.sport == "soccer" ? SportModels.soccer(g, summary: sum) : SportModels.basketball(g, summary: sum))
                }
            }
            var r: [(String, GameMoment?)] = []
            for await x in group { r.append(x) }
            return r
        }
        for (id, mo) in results { out[id] = mo }
        modelMoments = out.compactMapValues { $0 }
    }

    /// What's going on, in plain words. Live scoreboard first, then X chatter, then what the odds alone say.
    func moment(for m: Market) -> GameMoment? {
        var mo: GameMoment?
        if m.live, let g = ESPN.match(m, in: games) {
            let rule = g.moment
            if var model = modelMoments[g.id] {
                // Model headline ("Arsenal pressing: 31% chance of a goal in 10 min") + what's on the scoreboard.
                model.detail = [rule?.headline, model.detail].compactMap { $0 }.joined(separator: ". ")
                model.mustSee = model.mustSee || rule?.mustSee == true
                mo = model
            } else {
                mo = rule
            }
        }
        if let pulse = xPulse, xMarketKey == Self.key(m), let buzz = pulse.buzzPhrase {
            let line = "People on X are posting \"\(buzz.phrase)\" (\(buzz.posts) posts)"
            if mo == nil {
                mo = GameMoment(symbol: "bubble.left.and.text.bubble.right.fill", emoji: "💬", headline: line, mustSee: buzz.mustSee)
            } else {
                mo!.detail = [mo!.detail, line].compactMap { $0 }.joined(separator: ". ")
                mo!.mustSee = mo!.mustSee || buzz.mustSee
            }
        }
        return mo ?? oddsMoment(m)
    }

    /// Reads the last 15 minutes of odds: lead changes, surges, someone closing in.
    private func oddsMoment(_ m: Market) -> GameMoment? {
        guard let then = history[m.id]?.last(where: { Date().timeIntervalSince($0.t) >= 15 * 60 })
                ?? history[m.id]?.first, Date().timeIntervalSince(then.t) >= 5 * 60 else { return nil }
        let (side, from, to) = Self.risingSide(m, from: then.p)
        let mins = Int(Date().timeIntervalSince(then.t) / 60)
        let sports = m.category == .sports
        if from < 0.5 && to > 0.5 && to - from >= 0.05 {
            return GameMoment(symbol: "arrow.left.arrow.right", emoji: "🔄", headline: sports ? "Lead change: \(side) now favored" : "Flip: \(side) now more likely than not",
                              detail: "\(side) \(Self.pct(from)) → \(Self.pct(to)) in \(mins) min")
        }
        if to >= 0.85 && to - from >= 0.08 {
            return GameMoment(symbol: "flag.checkered", emoji: "🏁", headline: sports ? "\(side) closing in on the win" : "\(side) now very likely",
                              detail: "\(side) \(Self.pct(from)) → \(Self.pct(to)) in \(mins) min")
        }
        if to - from >= 0.08 {
            return GameMoment(symbol: "arrow.up.right", emoji: "📈", headline: "\(side) surging",
                              detail: "\(side) \(Self.pct(from)) → \(Self.pct(to)) in \(mins) min")
        }
        if m.live, (0.4...0.6).contains(m.probability), (forecasts[m.id]?.expectedMovePts ?? 0) >= 12 {
            return GameMoment(symbol: "scalemass.fill", emoji: "⚖️", headline: "Neck and neck. Could go either way",
                              detail: "\(m.sideLabel) \(Self.pct(m.probability))")
        }
        return nil
    }

    /// The side whose odds went up, with its before and after: ("Ann Li", 0.42, 0.60).
    static func risingSide(_ m: Market, from p0: Double) -> (String, Double, Double) {
        if m.probability >= p0 { return (m.sideLabel, p0, m.probability) }
        let other = m.otherOutcome ?? (m.outcome.lowercased() == "yes" ? "No" : "the other side")
        return (other, 1 - p0, 1 - m.probability)
    }

    static func describeMove(_ m: Market, from p0: Double, minutes: Int) -> String {
        let (side, a, b) = risingSide(m, from: p0)
        return "\(side) jumped from \(pct(a)) to \(pct(b)) in \(max(minutes, 1)) min"
    }

    static func pct(_ p: Double) -> String { "\(Int((p * 100).rounded()))%" }

    // MARK: following

    static func key(_ m: Market) -> String { m.eventTitle ?? m.id }
    func isFollowed(_ m: Market) -> Bool { followed[Self.key(m)] != nil }

    func toggleFollow(_ m: Market) {
        let k = Self.key(m)
        if followed[k] != nil { followed[k] = nil } else { followed[k] = m.id }
        rerank()
        if followed[k] != nil { Task { await tick() } }   // backfill + forecast it right away
    }

    /// Every match we know about, for "Pick your matches": live and starting soon first.
    func browse(_ query: String) -> [Market] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        var seen = Set<String>()
        return markets.values
            .filter { q.isEmpty || ($0.eventTitle ?? $0.title).lowercased().contains(q) || $0.title.lowercased().contains(q) }
            .sorted { ($0.live || $0.startsSoon ? 1 : 0, $0.volume24h) > ($1.live || $1.startsSoon ? 1 : 0, $1.volume24h) }
            .filter { seen.insert(Self.key($0)).inserted }
    }

    /// Sends a sample so you can see what alerts look like.
    func sendTest() {
        let m = items.first?.market ?? Market(id: "demo", title: "Chiefs vs Bills", eventTitle: "Chiefs vs Bills", groupTitle: nil,
                                               outcome: "Chiefs", otherOutcome: "Bills", probability: 0.62, volume24h: 0,
                                               category: .sports, url: nil, endDate: nil, startTime: nil, live: true, tokenId: nil)
        let copy = mode.headsUp(m, chance: 47, moment: moment(for: m))
        post(Moment(id: "test-\(Int(Date().timeIntervalSince1970))", kind: .headsUp,
                    title: copy.title, body: copy.body + " (test)", date: Date()))
    }
}
