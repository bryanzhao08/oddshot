import SwiftUI
import Charts

struct MarketDetailView: View {
    @Environment(AppModel.self) private var model
    let marketId: String
    let title: String
    let outcome: String
    let source: String
    let url: URL?
    let probability: Double
    let category: MarketCategory
    var market: Market?

    @State private var selected: Date?
    @State private var loading = true
    @State private var watchBusy = false
    @State private var forecast: Forecast?
    @State private var forecastState: LoadState = .idle
    @State private var liveContext: LiveContext?
    @State private var rec: Recommendation?
    @AppStorage(Prefs.shotPersona) private var roleRaw = Persona.general.rawValue
    private var role: Persona { Persona(rawValue: roleRaw) ?? .general }

    init(ref: MarketRef) {
        self.init(marketId: ref.id, title: ref.title, outcome: ref.outcome, source: ref.source,
                  url: ref.url, probability: ref.probability, category: ref.category)
        self.market = ref.market
    }

    init(market: Market) {
        self.init(marketId: market.id, title: market.title, outcome: market.outcome, source: market.source,
                  url: market.url, probability: market.probability, category: market.category)
        self.market = market
    }

    init(marketId: String, title: String, outcome: String, source: String, url: URL?, probability: Double,
         category: MarketCategory) {
        self.marketId = marketId; self.title = title; self.outcome = outcome; self.source = source
        self.url = url; self.probability = probability; self.category = category
    }

    private var points: [PricePoint] { model.histories[marketId] ?? [] }
    private var spikes: [Spike] { model.spikes.filter { $0.marketId == marketId } }
    private var marketInsights: [Insight] { model.insights(for: marketId) }
    private var shot: Shot? { model.shots.first { $0.marketId == marketId } }
    private var current: Double { points.last?.p ?? probability }
    private var selectedPoint: PricePoint? {
        guard let selected, !points.isEmpty else { return nil }
        return points.min { abs($0.t.timeIntervalSince(selected)) < abs($1.t.timeIntervalSince(selected)) }
    }
    private var shownValue: Double { selectedPoint?.p ?? current }
    private var rangeDelta: Double {
        guard let first = points.first?.p else { return 0 }
        return shownValue - first
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                headerBlock
                if let liveContext { ContextChips(context: liveContext) }
                if let r = model.recommendation(id: marketId, marketId: nil, RecommendationSet(), role: role) ?? rec {
                    RecommendationView(rec: r, role: role)
                }
                chartBlock.panel(padding: 14)
                statsBlock
                forecastBlock
                actions
                if !marketInsights.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel(text: "Insights on this market", symbol: "lightbulb.max.fill")
                        ForEach(marketInsights) { InsightCard(insight: $0) }
                    }
                }
                if !spikes.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel(text: "Spikes on this market", symbol: "bolt.fill")
                        ForEach(spikes) { SpikeCard(spike: $0) }
                    }
                }
            }
            .padding(16)
        }
        .oddshotScreen()
        .navigationTitle(Market.sourceLabel(source))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: roleRaw) {
            guard let api = model.api else { return }
            rec = nil
            // Role-specific recommendation may call Claude server-side; it's optional, so failures are silent.
            async let c = try? api.context(marketId: marketId)
            rec = try? await api.recommendation(marketId: marketId, role: role)
            if let ctx = await c, !ctx.isEmpty { liveContext = ctx }
        }
        .task {
            async let f: Void = loadForecast()
            await model.loadHistory(marketId, force: true)
            loading = false
            await f
            if model.subsState == .idle { await model.loadSubscriptions() }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                await model.loadHistory(marketId, force: true)
                await loadForecast()
            }
        }
    }

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Badge(text: category.label.uppercased(), color: Theme.dim, symbol: category.symbol)
                if market?.live == true { LiveBadge() }
            }
            Text(title)
                .font(.system(size: 22, weight: .heavy))
                .foregroundStyle(.white)
            Text(outcome)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.dim)
            HStack(alignment: .lastTextBaseline, spacing: 10) {
                Text(Format.pct(shownValue))
                    .font(.system(size: 48, weight: .black, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .contentTransition(.numericText(value: shownValue))
                    .animation(.snappy, value: shownValue)
                ProbabilityChange(delta: rangeDelta, font: Theme.mono(15, .bold))
                Spacer()
                if let sp = selectedPoint {
                    Text(sp.t, format: .dateTime.hour().minute().second())
                        .font(Theme.mono(12))
                        .foregroundStyle(Theme.accent)
                }
            }
        }
    }

    @ViewBuilder private var chartBlock: some View {
        if loading && points.isEmpty {
            ProgressView().tint(Theme.accent).frame(maxWidth: .infinity, minHeight: 240)
        } else if points.count < 2 {
            StateMessage(symbol: "chart.xyaxis.line", title: "Building history",
                         message: "The server records a price every poll. Check back in a minute.")
                .frame(minHeight: 240)
        } else {
            let lo = points.map(\.p).min() ?? 0, hi = points.map(\.p).max() ?? 1
            let pad = max((hi - lo) * 0.2, 0.01)
            let domainLo = max(0, lo - pad), domainHi = min(1, hi + pad)
            let color = Theme.move(current - (points.first?.p ?? current))
            Chart {
                ForEach(points) { p in
                    AreaMark(x: .value("Time", p.t), yStart: .value("lo", domainLo), yEnd: .value("Probability", p.p))
                        .foregroundStyle(LinearGradient(colors: [color.opacity(0.3), color.opacity(0)], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Time", p.t), y: .value("Probability", p.p))
                        .foregroundStyle(color)
                        .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round))
                        .interpolationMethod(.monotone)
                }
                ForEach(spikes.filter { $0.detectedAt >= (points.first?.t ?? .distantPast) }) { s in
                    RuleMark(x: .value("Spike", s.detectedAt))
                        .foregroundStyle(Theme.severity(s.severity).opacity(0.8))
                        .lineStyle(StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
                        .annotation(position: .top, alignment: .center) {
                            Image(systemName: "bolt.fill")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(Theme.severity(s.severity))
                        }
                }
                if let sp = selectedPoint {
                    RuleMark(x: .value("Selected", sp.t))
                        .foregroundStyle(Theme.accent.opacity(0.6))
                    PointMark(x: .value("Selected", sp.t), y: .value("Probability", sp.p))
                        .foregroundStyle(Theme.accent)
                        .symbolSize(70)
                }
            }
            .chartYScale(domain: domainLo...domainHi)
            .chartXSelection(value: $selected)
            .chartYAxis {
                AxisMarks(position: .trailing, values: .automatic(desiredCount: 4)) { v in
                    AxisGridLine().foregroundStyle(Theme.stroke)
                    AxisValueLabel {
                        if let d = v.as(Double.self) { Text(Format.pct(d)).font(Theme.mono(9)).foregroundStyle(Theme.faint) }
                    }
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                    AxisGridLine().foregroundStyle(Theme.stroke)
                    AxisValueLabel(format: .dateTime.hour().minute()).foregroundStyle(Theme.faint)
                }
            }
            .frame(height: 260)
            .sensoryFeedback(.selection, trigger: selectedPoint?.t)
            Text("Drag to scrub · ⚡ = detected spike")
                .font(Theme.mono(10)).foregroundStyle(Theme.faint)
        }
    }

    @ViewBuilder private var statsBlock: some View {
        if let m = market {
            HStack(spacing: 10) {
                stat("24h volume", Format.money(m.volume24h))
                stat("Liquidity", Format.money(m.liquidity))
                stat("Ends", m.endDate.map { $0.formatted(.dateTime.month(.abbreviated).day()) } ?? "—")
            }
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(Theme.mono(9, .bold)).foregroundStyle(Theme.faint)
            Text(value).font(Theme.mono(15, .bold)).foregroundStyle(.white)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .panel(padding: 12)
    }

    private func loadForecast() async {
        guard let api = model.api else { return }
        if forecast == nil { forecastState = .loading }
        do {
            forecast = try await api.forecast(marketId: marketId)
            forecastState = .loaded
        } catch {
            if forecast == nil {
                forecastState = .failed(error.isNotFound ? "Forecasts aren’t available on this server yet." : error.localizedDescription)
            }
        }
    }

    @ViewBuilder private var forecastBlock: some View {
        let f = forecast ?? shot?.forecast
        let color = shot?.kind.color ?? Theme.accent
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                SectionLabel(text: "Next 30 min", symbol: "sparkles")
                Spacer()
                if let f { Badge(text: f.isHeuristic ? "HEURISTIC" : "ML", color: f.isHeuristic ? Theme.dim : Theme.accent) }
            }
            if let f {
                HStack(spacing: 14) {
                    if let shot {
                        ScoreRing(score: shot.dramaScore, color: color).frame(width: 56, height: 56)
                    }
                    ForecastMeter(forecast: f, color: color)
                }
                if let shot {
                    HStack(spacing: 8) {
                        Badge(text: shot.kind.label.uppercased(), color: shot.kind.color, filled: true, symbol: shot.kind.symbol)
                        Text(shot.headline).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).lineLimit(2)
                    }
                }
                if !f.drivers.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("WHAT’S DRIVING IT").font(Theme.mono(9, .heavy)).tracking(1).foregroundStyle(Theme.faint)
                        let maxImpact = max(f.drivers.map { abs($0.impact) }.max() ?? 1, 0.0001)
                        ForEach(f.drivers.prefix(5)) { d in
                            DriverRow(driver: d, maxImpact: maxImpact)
                        }
                    }
                }
                Text("Model \(f.modelLabel)" + (f.historyMinutes.map { " · \(Int($0)) min of history" } ?? ""))
                    .font(Theme.mono(9)).foregroundStyle(Theme.faint)
            } else {
                switch forecastState {
                case .failed(let msg):
                    Label(msg, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(Theme.dim)
                default:
                    HStack { ProgressView().tint(Theme.accent); Text("Forecasting…").font(.footnote).foregroundStyle(Theme.dim) }
                }
            }
        }
        .panel(padding: 14)
    }

    private var actions: some View {
        let watching = model.isWatching(marketId)
        return VStack(spacing: 10) {
            Button {
                watchBusy = true
                Task { await model.toggleWatch(id: marketId, title: title); watchBusy = false }
            } label: {
                Label(watching ? "Watching" : "Watch this market", systemImage: watching ? "eye.fill" : "eye")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(watching ? Theme.panelHi : Theme.accent)
            .foregroundStyle(watching ? Theme.accent : .black)
            .disabled(watchBusy)
            .sensoryFeedback(.success, trigger: watching)

            if let url {
                Link(destination: url) {
                    Label("Open on \(Market.sourceLabel(source))", systemImage: "arrow.up.right.square")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.bordered)
                .tint(.white)
            }
            Button {
                Task { await model.simulateSpike(marketId: marketId) }
            } label: {
                Label("Simulate a spike here", systemImage: "wand.and.stars")
                    .font(.subheadline.weight(.semibold))
            }
            .tint(Theme.dim)
            .padding(.top, 2)
        }
    }
}

struct DriverRow: View {
    let driver: ForecastDriver
    let maxImpact: Double

    var body: some View {
        let frac = min(abs(driver.impact) / maxImpact, 1)
        let color = driver.impact >= 0 ? Theme.up : Theme.down
        HStack(spacing: 8) {
            Image(systemName: driver.impact >= 0 ? "plus.circle.fill" : "minus.circle.fill")
                .font(.system(size: 11)).foregroundStyle(color)
            Text(driver.label).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
            if let v = driver.valueLabel {
                Text(v).font(Theme.mono(10)).foregroundStyle(Theme.faint).lineLimit(1)
            }
            Spacer(minLength: 4)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.06))
                    Capsule().fill(color).frame(width: max(3, g.size.width * frac))
                }
            }
            .frame(width: 70, height: 5)
        }
    }
}
