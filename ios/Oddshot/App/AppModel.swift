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

    // Subscriptions
    var subscriptions: [Subscription] = []
    var subsState: LoadState = .idle

    // Misc
    var toast: String?
    var serverURL: String = ServerConfig.current

    @ObservationIgnored private let sse = SSEConnection()
    @ObservationIgnored private var historyInFlight: Set<String> = []

    var api: APIClient? { ServerConfig.url(from: serverURL).map { APIClient(baseURL: $0) } }

    init() {
        sse.onState = { [weak self] s in
            guard let self else { return }
            let wasLive = self.connection.isLive
            self.connection = s
            // Refresh snapshots after a reconnect so we don't miss anything.
            if s == .live && !wasLive { Task { await self.refreshPulse() } }
        }
        sse.onEvent = { [weak self] ev in self?.handle(ev) }
    }

    // MARK: Lifecycle

    func start() {
        guard let api else { connection = .failed("Invalid server URL"); return }
        sse.start(url: api.url("/api/stream"))
        Task {
            await refreshPulse()
            await loadSubscriptions()
        }
    }

    func stop() {
        sse.stop()
        connection = .idle
    }

    func applyServerURL(_ s: String) {
        UserDefaults.standard.set(s, forKey: ServerConfig.key)
        serverURL = ServerConfig.current
        spikes = []; movers = []; histories = [:]; subscriptions = []
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
        default: break
        }
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
