import SwiftUI
import Charts

struct MoversView: View {
    @Environment(AppModel.self) private var model
    @State private var category: MarketCategory?

    private var filtered: [Mover] {
        guard let category else { return model.movers }
        return model.movers.filter { $0.market.category == category }
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.moversState {
                case .loading where model.movers.isEmpty, .idle:
                    ProgressView().tint(Theme.accent).frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed(let msg) where model.movers.isEmpty:
                    StateMessage(symbol: "chart.line.downtrend.xyaxis", title: "Couldn’t load movers", message: msg,
                                 actionTitle: "Retry") { Task { await model.loadMovers() } }
                        .frame(maxHeight: .infinity)
                default:
                    list
                }
            }
            .oddshotScreen()
            .navigationTitle("Movers")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { ConnectionPill(state: model.connection) }
                ToolbarItem(placement: .topBarTrailing) { RoleMenu() }
            }
            .navigationDestination(for: Market.self) { m in
                MarketDetailView(market: m)
            }
        }
        .task {
            await model.loadMovers()
            // Keep movers fresh while the tab is visible (server polls every ~20s).
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                await model.loadMovers()
            }
        }
    }

    private var list: some View {
        List {
            Section {
                CategoryChips(selection: $category)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowBackground(Color.clear)
            }
            if filtered.isEmpty {
                StateMessage(symbol: "tortoise.fill", title: "Nothing moving",
                             message: "No movers yet — the server needs a few polls to build price history.")
                    .listRowBackground(Color.clear)
            }
            ForEach(filtered) { mover in
                NavigationLink(value: mover.market) {
                    MoverRow(mover: mover, points: model.histories[mover.market.id])
                }
                .listRowBackground(Theme.panel)
                .listRowSeparatorTint(Theme.stroke)
                .task { await model.loadHistory(mover.market.id) }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable {
            model.histories = [:]
            await model.loadMovers()
        }
    }
}

struct CategoryChips: View {
    @Binding var selection: MarketCategory?
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(nil, "All", "square.grid.2x2.fill")
                ForEach(MarketCategory.known) { c in chip(c, c.label, c.symbol) }
            }
            .padding(.horizontal, 4)
        }
    }

    private func chip(_ c: MarketCategory?, _ label: String, _ symbol: String) -> some View {
        let on = selection == c
        return Button {
            withAnimation(.snappy) { selection = c }
        } label: {
            Label(label, systemImage: symbol)
                .font(.system(size: 12, weight: .bold))
                .padding(.horizontal, 10).padding(.vertical, 7)
                .foregroundStyle(on ? Color.black : Color.white.opacity(0.8))
                .background(on ? Theme.accent : Theme.panelHi, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

struct MoverRow: View {
    let mover: Mover
    let points: [PricePoint]?

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    if mover.market.live { LiveBadge() }
                    Image(systemName: mover.market.category.symbol).font(.system(size: 10))
                    Text(mover.market.sourceLabel).font(Theme.mono(10, .bold))
                }
                .foregroundStyle(Theme.dim)
                Text(mover.market.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                Text(mover.market.outcome)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.dim)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Sparkline(points: points ?? [], delta: mover.change1h)
                .frame(width: 64, height: 30)
            VStack(alignment: .trailing, spacing: 3) {
                Text(Format.pct(mover.market.probability))
                    .font(Theme.mono(16, .heavy))
                    .foregroundStyle(.white)
                    .contentTransition(.numericText(value: mover.market.probability))
                ProbabilityChange(delta: mover.change1h, font: Theme.mono(12, .bold))
                Text("1h").font(Theme.mono(9)).foregroundStyle(Theme.faint)
            }
            .frame(minWidth: 56, alignment: .trailing)
        }
        .padding(.vertical, 4)
        .animation(.default, value: mover.market.probability)
    }
}

struct Sparkline: View {
    let points: [PricePoint]
    let delta: Double

    var body: some View {
        if points.count < 2 {
            Capsule().fill(Color.white.opacity(0.06)).frame(height: 2)
        } else {
            let lo = points.map(\.p).min() ?? 0, hi = points.map(\.p).max() ?? 1
            let pad = max((hi - lo) * 0.15, 0.005)
            Chart(points) { p in
                LineMark(x: .value("t", p.t), y: .value("p", p.p))
                    .interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 1.6, lineCap: .round))
                    .foregroundStyle(Theme.move(delta))
            }
            .chartYScale(domain: (lo - pad)...(hi + pad))
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
        }
    }
}
