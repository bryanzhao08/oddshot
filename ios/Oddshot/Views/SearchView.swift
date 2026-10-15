import SwiftUI

struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var category: MarketCategory?
    @State private var results: [Market] = []
    @State private var state: LoadState = .idle

    private struct Key: Equatable { let q: String; let c: MarketCategory?; let server: String }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    CategoryChips(selection: $category)
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                        .listRowBackground(Color.clear)
                }
                content
            }
            .listStyle(.insetGrouped)
            .oddshotScreen()
            .navigationTitle("Search")
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Lakers, Fed, Taylor Swift…")
            .navigationDestination(for: Market.self) { MarketDetailView(market: $0) }
            .task(id: Key(q: query, c: category, server: model.serverURL)) {
                // Debounce typing.
                if !query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
                if Task.isCancelled { return }
                await search()
            }
            .task { if model.subsState == .idle { await model.loadSubscriptions() } }
        }
    }

    @ViewBuilder private var content: some View {
        switch state {
        case .loading where results.isEmpty, .idle:
            HStack { Spacer(); ProgressView().tint(Theme.accent); Spacer() }
                .listRowBackground(Color.clear)
        case .failed(let msg):
            StateMessage(symbol: "wifi.exclamationmark", title: "Search failed", message: msg, actionTitle: "Retry") {
                Task { await search() }
            }
            .listRowBackground(Color.clear)
        default:
            if results.isEmpty {
                StateMessage(symbol: "magnifyingglass", title: query.isEmpty ? "No markets loaded yet" : "No matches",
                             message: query.isEmpty ? "The server hasn’t completed its first poll." : "Try a team, person, ticker or topic.")
                    .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(results) { m in
                        NavigationLink(value: m) { SearchRow(market: m) }
                            .listRowBackground(Theme.panel)
                            .listRowSeparatorTint(Theme.stroke)
                    }
                } header: {
                    SectionLabel(text: query.isEmpty ? "Top by 24h volume" : "\(results.count) results")
                }
            }
        }
    }

    private func search() async {
        guard let api = model.api else { state = .failed(APIError.badURL.localizedDescription); return }
        state = .loading
        do {
            results = try await api.markets(q: query.trimmingCharacters(in: .whitespaces), category: category?.raw ?? "", limit: 50)
            state = .loaded
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

struct SearchRow: View {
    @Environment(AppModel.self) private var model
    let market: Market
    @State private var busy = false

    var body: some View {
        let watching = model.isWatching(market.id)
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    if market.live { LiveBadge() }
                    Image(systemName: market.category.symbol).font(.system(size: 10))
                    Text("\(market.sourceLabel) · \(Format.money(market.volume24h)) 24h").font(Theme.mono(10, .bold))
                }
                .foregroundStyle(Theme.dim)
                Text(market.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    Text(market.outcome).foregroundStyle(Theme.dim).lineLimit(1)
                    if let c = market.change1h, abs(c) >= 0.005 { ProbabilityChange(delta: c, font: Theme.mono(11, .bold)) }
                }
                .font(.system(size: 12))
            }
            Spacer(minLength: 4)
            Text(Format.pct(market.probability))
                .font(Theme.mono(17, .heavy))
                .foregroundStyle(.white)
            Button {
                busy = true
                Task { await model.toggleWatch(id: market.id, title: market.title); busy = false }
            } label: {
                Image(systemName: watching ? "eye.fill" : "eye")
                    .font(.system(size: 15, weight: .bold))
                    .frame(width: 36, height: 36)
                    .foregroundStyle(watching ? .black : Theme.accent)
                    .background(watching ? Theme.accent : Theme.accent.opacity(0.12), in: Circle())
            }
            .buttonStyle(.borderless)
            .disabled(busy)
            .accessibilityLabel(watching ? "Stop watching" : "Watch")
        }
        .padding(.vertical, 4)
    }
}
