import SwiftUI

/// The v2 hero: a ranked, forward-looking list of what to watch (or shoot) next.
struct ShotsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(Prefs.shotPersona) private var personaRaw = Persona.general.rawValue
    @State private var path = NavigationPath()

    private var persona: Persona { Persona(rawValue: personaRaw) ?? .general }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .oddshotScreen()
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Wordmark() }
                    ToolbarItem(placement: .topBarTrailing) { RoleMenu() }
                }
                .navigationDestination(for: MarketRef.self) { r in MarketDetailView(ref: r) }
        }
        .onChange(of: personaRaw) { _, _ in
            Task { await model.personaChanged() }
        }
        .task {
            if model.shots.isEmpty { await model.loadShots() }
            // SSE `shots` events normally keep this fresh; poll slowly as a fallback.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(45))
                if !model.connection.isLive || model.persona != .general { await model.loadShots() }
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.shotsState {
        case .idle where model.shots.isEmpty, .loading where model.shots.isEmpty:
            ScrollView {
                VStack(spacing: 12) {
                    header
                    ForEach(0..<3, id: \.self) { _ in ShotCardPlaceholder() }
                }
                .padding(14)
            }
        case .failed(let msg) where model.shots.isEmpty:
            ScrollView {
                VStack(spacing: 12) {
                    header
                    StateMessage(symbol: "scope", title: "Shot List unavailable", message: msg, actionTitle: "Retry") {
                        Task { await model.loadShots() }
                    }
                    .panel()
                }
                .padding(14)
            }
            .refreshable { await model.loadShots() }
        default:
            list
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("What to watch next")
                .font(.system(size: 26, weight: .black, design: .rounded))
                .foregroundStyle(.white)
            HStack(spacing: 6) {
                Text(persona == .general ? "Ranked by drama for everyone" : "Ranked for \(persona.label.lowercased())s")
                if let t = model.shotsUpdatedAt {
                    Text("·")
                    Text(t, style: .relative) + Text(" ago")
                }
                Spacer()
                ConnectionPill(state: model.connection)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(Theme.dim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var list: some View {
        List {
            header
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 8, leading: 14, bottom: 4, trailing: 14))
            if model.shots.isEmpty {
                StateMessage(symbol: "binoculars.fill", title: "Nothing worth a shot yet",
                             message: "Markets are calm. As soon as something gets tense, it lands here — ranked.")
                    .panel()
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            ForEach(Array(model.shots.enumerated()), id: \.element.key) { i, shot in
                ShotCard(shot: shot, position: i + 1, persona: persona,
                         rankDelta: model.shotRankDelta[shot.key] ?? 0,
                         points: model.histories[shot.marketId] ?? [],
                         watching: model.isWatching(shot.marketId),
                         recommendation: model.recommendation(id: shot.id, marketId: shot.marketId,
                                                              shot.recommendations, role: persona),
                         onWatch: { watch(shot) },
                         onOpen: { open(shot) })
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14))
                    .task(id: shot.marketId) { await model.loadHistory(shot.marketId) }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        Button { watch(shot) } label: {
                            Label(model.isWatching(shot.marketId) ? "Unwatch" : "Watch", systemImage: "eye")
                        }
                        .tint(Theme.accent)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button { open(shot) } label: { Label("Details", systemImage: "chart.xyaxis.line") }
                            .tint(Theme.violet)
                        if let url = shot.market?.url {
                            Link(destination: url) { Label("Open", systemImage: "arrow.up.right.square") }
                                .tint(Theme.sky)
                        }
                    }
                    .contextMenu {
                        Button { watch(shot) } label: { Label("Watch", systemImage: "eye") }
                        Button { open(shot) } label: { Label("Details", systemImage: "chart.xyaxis.line") }
                        if let url = shot.market?.url {
                            Link(destination: url) { Label("Open on \(shot.market?.sourceLabel ?? "venue")", systemImage: "arrow.up.right.square") }
                        }
                    }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .animation(.spring(response: 0.5, dampingFraction: 0.82), value: model.shots.map(\.key))
        .animation(.snappy, value: model.shotRankDelta)
        .refreshable { await model.loadShots() }
    }

    private func watch(_ shot: Shot) {
        Task { await model.toggleWatch(id: shot.marketId, title: shot.title) }
    }

    private func open(_ shot: Shot) {
        let ref = shot.market.map(MarketRef.init(market:)) ?? model.ref(for: shot.marketId, title: shot.title)
        path.append(ref)
    }
}
