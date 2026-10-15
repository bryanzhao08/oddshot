import Foundation
import Observation
import AudioToolbox

enum LoadState: Equatable {
    case idle, loading, loaded, failed(String)
    var error: String? { if case .failed(let m) = self { m } else { nil } }
}

/// Single source of truth for live data shared across tabs.
@MainActor
@Observable
final class AppModel {
    // Live stream
    var connection: ConnectionState = .idle
    var vix = VolatilityIndex()
    var vixHistory: [VixPoint] = []
    var spikes: [Spike] = []
    var feedState: LoadState = .idle
    var lastTick: Date?
    var marketCount: Int = 0
    /// Incremented on every new *major* spike; drives haptics via .sensoryFeedback.
    var majorSpikeTick = 0
    var freshSpikeIds: Set<String> = []

    // Movers
    var movers: [Mover] = []
    var moversState: LoadState = .idle
    var histories: [String: [PricePoint]] = [:]

    // v2: Shot List
    var shots: [Shot] = []
    var shotsState: LoadState = .idle
    /// Rank movement since the previous refresh, keyed by `Shot.key` (positive = climbed).
    var shotRankDelta: [String: Int] = [:]
    var shotsUpdatedAt: Date?

    // v2: Insights / Stories / Briefing
    var insights: [Insight] = []
    var insightsState: LoadState = .idle
    var freshInsightIds: Set<String> = []
    var stories: [Story] = []
    var briefing: Briefing?

    // v3: recommendations pushed over SSE (`recommendation`), keyed by targetId → role.
    var recOverrides: [String: [String: Recommendation]] = [:]

    // Subscriptions
    var subscriptions: [Subscription] = []
    var subsState: LoadState = .idle

    // Misc
    var toast: String?
    var serverURL: String = ServerConfig.current

    @ObservationIgnored private let sse = SSEConnection()
    @ObservationIgnored private var historyInFlight: Set<String> = []
    @ObservationIgnored private var shotsInFlight = false
    /// Top-3 baseline per persona for "newly entered the top 3" notifications (nil = no baseline yet).
    @ObservationIgnored private var top3Baseline: (persona: Persona, keys: Set<String>)?

    var api: APIClient? { ServerConfig.url(from: serverURL).map { APIClient(baseURL: $0) } }

    init() {
        sse.onState = { [weak self] s in
            guard let self else { return }
            let wasLive = self.connection.isLive
            self.connection = s
            // Refresh snapshots after a reconnect so we don't miss anything.
            if s == .live && !wasLive {
                Task { await self.refreshPulse() }
                Task { await self.loadShots() }
            }
        }
        sse.onEvent = { [weak self] ev in self?.handle(ev) }
    }

    // MARK: Lifecycle

    private(set) var isRunning = false

    func start() {
        isRunning = true
        guard let api else { connection = .failed("Invalid server URL"); return }
        sse.start(url: api.url("/api/stream"))
        Task {
            await refreshPulse()
            await loadSubscriptions()
        }
        Task { await loadShots() }
    }

    func stop() {
        isRunning = false
        sse.stop()
        connection = .idle
    }

    func applyServerURL(_ s: String) {
        UserDefaults.standard.set(s, forKey: ServerConfig.key)
        serverURL = ServerConfig.current
        spikes = []; movers = []; histories = [:]; subscriptions = []
        shots = []; shotRankDelta = [:]; top3Baseline = nil; insights = []; stories = []; briefing = nil
        shotsState = .idle; insightsState = .idle
        vix = VolatilityIndex(); vixHistory = []
        start()
    }

    // MARK: SSE

    private func handle(_ ev: SSEEvent) {
        let data = Data(ev.data.utf8)
        switch ev.event {
        case "spike":
            guard let spike = try? JSONDecoder().decode(Spike.self, from: data) else { return }
            ingest(spike, fromStream: true)
        case "vix":
            if let v = try? JSONDecoder().decode(VolatilityIndex.self, from: data) {
                vix.overall = v.overall
                if !v.byCategory.isEmpty { vix.byCategory = v.byCategory }
                vix.updatedAt = v.updatedAt
                vixHistory.append(VixPoint(t: v.updatedAt ?? Date(), overall: v.overall))
                if vixHistory.count > 500 { vixHistory.removeFirst(vixHistory.count - 500) }
            }
        case "tick":
            struct Tick: Decodable { let at: LenientDouble?; let marketCount: Int? }
            if let t = try? JSONDecoder().decode(Tick.self, from: data) {
                if let ms = t.at?.value { lastTick = Date(timeIntervalSince1970: ms > 1e10 ? ms / 1000 : ms) } else { lastTick = Date() }
                if let c = t.marketCount { marketCount = c }
            }
        case "shots":
            let list = (try? JSONDecoder().decode(LenientList<Shot>.self, from: data))?.items ?? []
            guard !list.isEmpty else { return }
            // The stream carries the default ranking; other personas re-rank server-side.
            if persona == .general { applyShots(list, persona: .general) } else { Task { await loadShots() } }
        case "recommendation":
            guard let ev = try? JSONDecoder().decode(RecommendationEvent.self, from: data),
                  !ev.targetId.isEmpty, let rec = ev.recommendation, !rec.isEmpty else { return }
            recOverrides[ev.targetId, default: [:]][ev.role] = rec
        case "insight":
            guard let insight = try? JSONDecoder().decode(Insight.self, from: data) else { return }
            ingest(insight, fromStream: true)
        default: break
        }
    }

    // MARK: Shots

    var persona: Persona { Persona.active }

    /// Active role's recommendation for an item: SSE override (by item id, then market id) beats the embedded set.
    func recommendation(id: String, marketId: String? = nil, _ set: RecommendationSet, role: Persona) -> Recommendation? {
        for key in [id, marketId].compactMap({ $0 }) {
            if let o = recOverrides[key] {
                if let r = o[role.rawValue] { return r }
            }
        }
        if let r = set.byRole[role.rawValue] { return r }
        for key in [id, marketId].compactMap({ $0 }) {
            if let r = recOverrides[key]?["general"] { return r }
        }
        return set.for(role)
    }

    func loadShots() async {
        guard let api else { shotsState = .failed(APIError.badURL.localizedDescription); return }
        guard !shotsInFlight else { return }
        shotsInFlight = true
        defer { shotsInFlight = false }
        let p = persona
        if shots.isEmpty { shotsState = .loading }
        do {
            let list = try await api.shots(persona: p, limit: 20)
            guard p == persona else { return } // persona changed mid-flight
            applyShots(list, persona: p)
        } catch {
            if shots.isEmpty || error.isNotFound {
                shots = error.isNotFound ? [] : shots
                shotsState = .failed(error.isNotFound
                    ? "This server doesn’t serve the Shot List yet (/api/shots returned 404). Update the backend, or pull to retry."
                    : error.localizedDescription)
            }
        }
    }

    /// Persona switched: drop the old ranking (and the top-3 baseline) and refetch.
    func personaChanged() async {
        shotRankDelta = [:]
        top3Baseline = nil
        await loadShots()
    }

    private func applyShots(_ incoming: [Shot], persona p: Persona) {
        var list = incoming
        if list.contains(where: { $0.rank > 0 }) {
            list = list.enumerated().sorted {
                let a = $0.element.rank > 0 ? $0.element.rank : 1000 + $0.offset
                let b = $1.element.rank > 0 ? $1.element.rank : 1000 + $1.offset
                return a < b
            }.map(\.element)
        }
        // Dedupe by market so List identity stays stable.
        var seen = Set<String>()
        list = list.filter { seen.insert($0.key).inserted }

        let oldRank = Dictionary(shots.enumerated().map { ($1.key, $0) }, uniquingKeysWith: { a, _ in a })
        var delta: [String: Int] = [:]
        for (i, s) in list.enumerated() {
            if let o = oldRank[s.key], o != i { delta[s.key] = o - i }
        }
        if !shots.isEmpty { shotRankDelta = delta }
        shots = list
        shotsState = .loaded
        shotsUpdatedAt = Date()
        checkTop3(list, persona: p)
    }

    private func checkTop3(_ list: [Shot], persona p: Persona) {
        let top = Array(list.prefix(3))
        let keys = Set(top.map(\.key))
        defer { top3Baseline = (p, keys) }
        guard let base = top3Baseline, base.persona == p,
              UserDefaults.standard.object(forKey: Prefs.notifyTopShots) as? Bool ?? true,
              let newcomer = top.first(where: { !base.keys.contains($0.key) }) else { return }
        Task { await Notifier.postTopShot(newcomer, persona: p) }
    }

    // MARK: Insights

    func ingest(_ insight: Insight, fromStream: Bool) {
        guard !insights.contains(where: { $0.id == insight.id }) else { return }
        insights.insert(insight, at: 0)
        if insights.count > 150 { insights.removeLast(insights.count - 150) }
        insightsState = .loaded
        guard fromStream else { return }
        freshInsightIds.insert(insight.id)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4))
            self?.freshInsightIds.remove(insight.id)
        }
        if insight.severity >= .notable,
           UserDefaults.standard.object(forKey: Prefs.notifyInsights) as? Bool ?? true,
           !insight.matchedSubscriptions.isEmpty || subscriptions.contains(where: { matches($0, insight) }) {
            Task { await Notifier.post(insight) }
        }
    }

    /// Client-side mirror of the server's subscription matching, applied to insights.
    func matches(_ sub: Subscription, _ insight: Insight) -> Bool {
        guard insight.severity >= sub.minSeverity else { return false }
        let m = sub.match
        if !m.marketIds.isEmpty && Set(m.marketIds).isDisjoint(with: insight.marketIds) { return false }
        if !m.categories.isEmpty && !m.categories.map({ $0.lowercased() }).contains(insight.category.raw) { return false }
        if !m.sources.isEmpty {
            let srcs = Set(insight.marketIds.compactMap { $0.split(separator: ":").first.map(String.init) })
            if Set(m.sources.map { $0.lowercased() }).isDisjoint(with: srcs) { return false }
        }
        if !m.keywords.isEmpty {
            let hay = (insight.title + " " + insight.body).lowercased()
            if !m.keywords.contains(where: { !$0.isEmpty && hay.contains($0.lowercased()) }) { return false }
        }
        return true
    }

    func insights(for marketId: String) -> [Insight] { insights.filter { $0.marketIds.contains(marketId) } }

    /// Best-known Market for an id, from any loaded list.
    func knownMarket(_ id: String) -> Market? {
        shots.first(where: { $0.marketId == id })?.market ?? movers.first(where: { $0.market.id == id })?.market
    }

    func ref(for id: String, title: String, probability: Double = 0, category: MarketCategory = "other") -> MarketRef {
        if let m = knownMarket(id) { return MarketRef(market: m) }
        return MarketRef(id: id, title: title, probability: probability, category: category)
    }

    func loadInsightsStoriesBriefing() async {
        guard let api else { return }
        if insights.isEmpty { insightsState = .loading }
        async let st = try? api.stories()
        async let br = try? api.briefing()
        do {
            let list = try await api.insights(limit: 50)
            let existing = Set(insights.map(\.id))
            insights = (insights + list.filter { !existing.contains($0.id) }).sorted { $0.createdAt > $1.createdAt }
            insightsState = .loaded
        } catch {
            if insights.isEmpty {
                insightsState = .failed(error.isNotFound ? "Insights aren’t available on this server yet." : error.localizedDescription)
            }
        }
        if let s = await st { stories = s }
        if let b = await br, !b.isEmpty { briefing = b }
    }

    func ingest(_ spike: Spike, fromStream: Bool) {
        guard !spikes.contains(where: { $0.id == spike.id }) else { return }
        spikes.insert(spike, at: 0)
        if spikes.count > 200 { spikes.removeLast(spikes.count - 200) }
        feedState = .loaded
        freshSpikeIds.insert(spike.id)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4))
            self?.freshSpikeIds.remove(spike.id)
        }
        guard fromStream else { return }
        UserDefaults.standard.set(spike.detectedAt, forKey: Prefs.lastSeenAlert)
        if spike.severity == .major {
            majorSpikeTick += 1
            if UserDefaults.standard.object(forKey: Prefs.sound) as? Bool ?? true {
                AudioServicesPlaySystemSound(1057)
            }
        }
        if !spike.matchedSubscriptions.isEmpty {
            Task { await Notifier.post(spike) }
        }
    }

    // MARK: Loading

    func refreshPulse() async {
        guard let api else { feedState = .failed(APIError.badURL.localizedDescription); return }
        if spikes.isEmpty { feedState = .loading }
        async let v2: Void = loadInsightsStoriesBriefing()
        async let v = try? api.vix()
        let alertsResult: Result<[Spike], Error>
        do { alertsResult = .success(try await api.alerts(limit: 60)) } catch { alertsResult = .failure(error) }
        if let v = await v {
            vix = v
            if let h = v.history, !h.isEmpty { vixHistory = h.filter { $0.t != .distantPast } }
        }
        switch alertsResult {
        case .success(let list):
            let existing = Set(spikes.map(\.id))
            let merged = spikes + list.filter { !existing.contains($0.id) }
            spikes = merged.sorted { $0.detectedAt > $1.detectedAt }
            feedState = .loaded
        case .failure(let e):
            if spikes.isEmpty { feedState = .failed(e.localizedDescription) }
        }
        await v2
    }

    func loadMovers() async {
        guard let api else { moversState = .failed(APIError.badURL.localizedDescription); return }
        if movers.isEmpty { moversState = .loading }
        do {
            movers = try await api.movers(limit: 30)
            moversState = .loaded
        } catch {
            if movers.isEmpty { moversState = .failed(error.localizedDescription) }
        }
    }

    func loadHistory(_ marketId: String, force: Bool = false) async {
        guard let api, force || histories[marketId] == nil, !historyInFlight.contains(marketId) else { return }
        historyInFlight.insert(marketId)
        defer { historyInFlight.remove(marketId) }
        if let pts = try? await api.history(marketId: marketId) { histories[marketId] = pts }
    }

    func loadSubscriptions() async {
        guard let api else { subsState = .failed(APIError.badURL.localizedDescription); return }
        if subscriptions.isEmpty { subsState = .loading }
        do {
            subscriptions = try await api.subscriptions()
            subsState = .loaded
        } catch {
            subsState = .failed(error.localizedDescription)
        }
    }

    // MARK: Mutations

    func save(_ sub: Subscription) async throws {
        guard let api else { throw APIError.badURL }
        if sub.id.isEmpty {
            let created = try await api.create(sub)
            subscriptions.append(created)
            if await Notifier.authorizationStatus() == .notDetermined { await Notifier.requestAuthorization() }
        } else {
            let updated = try await api.update(sub)
            if let i = subscriptions.firstIndex(where: { $0.id == sub.id }) { subscriptions[i] = updated }
        }
    }

    func delete(_ sub: Subscription) async {
        guard let api else { return }
        subscriptions.removeAll { $0.id == sub.id }
        do { try await api.delete(subscriptionId: sub.id) } catch {
            flash("Delete failed: \(error.localizedDescription)")
            await loadSubscriptions()
        }
    }

    func isWatching(_ marketId: String) -> Bool {
        subscriptions.contains { $0.match.marketIds.contains(marketId) }
    }

    func toggleWatch(id: String, title: String) async {
        if let existing = subscriptions.first(where: { $0.match.marketIds == [id] }) {
            await delete(existing)
            flash("Stopped watching")
            return
        }
        var sub = Subscription.blank
        sub.name = "Watch: \(title)"
        sub.match.marketIds = [id]
        sub.minDelta = 0.03
        do {
            try await save(sub)
            flash("Watching — you’ll be alerted on 3+ pt moves")
        } catch {
            flash("Couldn’t watch: \(error.localizedDescription)")
        }
    }

    func simulateSpike(marketId: String? = nil) async {
        guard let api else { return }
        do {
            let s = try await api.simulateSpike(marketId: marketId)
            // The SSE stream normally delivers it; insert directly in case the stream is down.
            if !connection.isLive { ingest(s, fromStream: false) }
            flash("Demo spike injected")
        } catch {
            flash("Simulate failed: \(error.localizedDescription)")
        }
    }

    func flash(_ msg: String) {
        toast = msg
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2.5))
            if self?.toast == msg { self?.toast = nil }
        }
    }
}
