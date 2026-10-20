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
    var id: String { market.id }
    /// Typical biggest swing over the next 30 min, in points.
    var expectedPts: Int { Int((forecast?.expectedMovePts ?? 0).rounded()) }
}

/// The whole engine, on the phone: poll Polymarket every 20 s, keep price history,
/// forecast the next 30 minutes, and send a local notification when something's up.
@MainActor @Observable
final class Watcher {
    static let shared = Watcher()

    var mode: Mode { didSet { UserDefaults.standard.set(mode.rawValue, forKey: "mode"); rerank() } }
    var onboarded: Bool { didSet { UserDefaults.standard.set(onboarded, forKey: "onboarded") } }

    private(set) var items: [WatchItem] = []
    private(set) var moments: [Moment] = []
    private(set) var lastUpdate: Date?
    private(set) var offline = false

    private var markets: [String: Market] = [:]
    private var history: [String: [PricePoint]] = [:]
    private var forecasts: [String: MoveForecast] = [:]
    private var earlier: [String: MoveForecast] = [:]   // the same forecast as of 15 min ago
    private var backfilled: Set<String> = []
    private var lastAlert: [String: Date] = [:]
    private var lastAnyAlert: Date?
    private var model: ForecastModel?
    private var loop: Task<Void, Never>?
    private var ticking = false

    private init() {
        let d = UserDefaults.standard
        mode = Mode(rawValue: d.string(forKey: "mode") ?? "") ?? .sports
        onboarded = d.bool(forKey: "onboarded")
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

        guard let fetched = try? await Polymarket.topMarkets(limit: 200) else { offline = true; return }
        offline = false
        let now = Date()
        for m in fetched {
            markets[m.id] = m
            var h = (history[m.id] ?? []).filter { now.timeIntervalSince($0.t) < 6 * 3600 }
            h.append(PricePoint(t: now, p: m.probability))
            history[m.id] = h
        }
        let relevant = fetched.filter(mode.cares)
        await backfill(relevant, max: background ? 8 : 24)
        await forecast(Array(relevant.prefix(background ? 30 : 80)))
        checkForAlerts(relevant, now: now)
        rerank()
        lastUpdate = now
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

        for m in ms where !quiet(m) {
            guard let h = history[m.id] else { continue }
            let window = h.filter { now.timeIntervalSince($0.t) <= 10 * 60 }
            guard let from = window.max(by: { abs(m.probability - $0.p) < abs(m.probability - $1.p) }) else { continue }
            let delta = m.probability - from.p
            let bar = max(0.06 * mode.pickiness, 0.45 * (forecasts[m.id]?.expectedMovePts ?? 0) / 100)
            guard abs(delta) >= bar else { continue }
            let copy = mode.happening(m, deltaPts: delta * 100, minutes: Int(now.timeIntervalSince(from.t) / 60))
            alert(.happening, m, copy, now)
            return
        }

        let bar = min(0.35 * mode.pickiness, 0.9)
        let heatingUp = ms.compactMap { m -> (Market, Double)? in
            guard !quiet(m), let f = forecasts[m.id], let b = earlier[m.id],
                  f.pMove30 >= bar, b.pMove30 < bar * 0.7 else { return nil }
            return (m, f.pMove30)
        }
        if let (m, p) = heatingUp.max(by: { $0.1 < $1.1 }) {
            alert(.headsUp, m, mode.headsUp(m, chance: Int((p * 100).rounded())), now)
        }
    }

    private func alert(_ kind: Moment.Kind, _ m: Market, _ copy: (title: String, body: String), _ now: Date) {
        lastAlert[m.eventTitle ?? m.id] = now
        lastAnyAlert = now
        post(Moment(id: "\(kind.rawValue)-\(m.id)-\(Int(now.timeIntervalSince1970))", kind: kind,
                    title: copy.title, body: copy.body, date: now))
    }

    private func post(_ moment: Moment) {
        moments = Array(([moment] + moments).filter { Date().timeIntervalSince($0.date) < 12 * 3600 }.prefix(30))
        UserDefaults.standard.set(try? JSONEncoder().encode(moments), forKey: "moments")
        Notifier.post(moment)
    }

    private func rerank() {
        let now = Date()
        items = markets.values.filter(mode.cares)
            .map { WatchItem(market: $0, forecast: forecasts[$0.id],
                             recent: (history[$0.id] ?? []).filter { now.timeIntervalSince($0.t) < 3600 }) }
            .sorted { a, b in
                let sa = a.forecast?.expectedMovePts ?? 0, sb = b.forecast?.expectedMovePts ?? 0
                return sa != sb ? sa > sb : a.market.volume24h > b.market.volume24h
            }
        var seen = Set<String>()   // one row per game/event
        items = items.filter { seen.insert($0.market.eventTitle ?? $0.id).inserted }
    }

    /// Sends a sample so you can see what alerts look like.
    func sendTest() {
        let m = items.first?.market ?? Market(id: "demo", title: "Chiefs vs Bills", eventTitle: "Chiefs vs Bills", groupTitle: nil,
                                               outcome: "Chiefs", otherOutcome: "Bills", probability: 0.62, volume24h: 0,
                                               category: .sports, url: nil, endDate: nil, startTime: nil, live: true, tokenId: nil)
        let copy = mode.headsUp(m, chance: 47)
        post(Moment(id: "test-\(Int(Date().timeIntervalSince1970))", kind: .headsUp,
                    title: copy.title, body: copy.body + " (test)", date: Date()))
    }
}
