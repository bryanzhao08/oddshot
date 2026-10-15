import SwiftUI
import Charts

struct PulseView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(Prefs.haptics) private var hapticsOn = true
    @State private var simulating = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    header
                    VolatilityGauge(value: model.vix.overall, history: model.vixHistory)
                        .panel(padding: 18)
                    CategoryBars(byCategory: model.vix.byCategory)
                        .panel()
                    feed
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 24)
            }
            .refreshable { await model.refreshPulse() }
            .oddshotScreen()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Wordmark() }
                ToolbarItem(placement: .topBarTrailing) { ConnectionPill(state: model.connection) }
            }
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Spike.self) { s in
                MarketDetailView(marketId: s.marketId, title: s.title, outcome: s.outcome, source: s.source,
                                 url: s.url, probability: s.to, category: s.category)
            }
        }
        .sensoryFeedback(trigger: model.majorSpikeTick) { _, _ in
            hapticsOn ? .impact(weight: .heavy, intensity: 1) : nil
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("The odds move before the headlines do.")
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.dim)
            Spacer()
            if model.marketCount > 0 {
                Text("\(model.marketCount) mkts")
                    .font(Theme.mono(11))
                    .foregroundStyle(Theme.faint)
                    .contentTransition(.numericText(value: Double(model.marketCount)))
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder private var feed: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionLabel(text: "Spike feed", symbol: "bolt.fill")
                Spacer()
                Button {
                    simulating = true
                    Task { await model.simulateSpike(); simulating = false }
                } label: {
                    Label("Simulate", systemImage: simulating ? "hourglass" : "wand.and.stars")
                        .font(Theme.mono(11, .bold))
                }
                .buttonStyle(.bordered)
                .tint(Theme.accent)
                .disabled(simulating)
            }
            switch model.feedState {
            case .loading where model.spikes.isEmpty, .idle where model.spikes.isEmpty:
                ForEach(0..<3, id: \.self) { _ in SpikeCardPlaceholder() }
            case .failed(let msg) where model.spikes.isEmpty:
                StateMessage(symbol: "antenna.radiowaves.left.and.right.slash", title: "Can’t reach Oddshot server",
                             message: msg, actionTitle: "Retry") {
                    model.start()
                }
                .panel()
            default:
                if model.spikes.isEmpty {
                    StateMessage(symbol: "waveform.path.ecg", title: "Quiet for now",
                                 message: "No spikes yet. Markets are being watched — big moves will land here instantly. Tap Simulate to see one.")
                        .panel()
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(model.spikes) { spike in
                            NavigationLink(value: spike) {
                                SpikeCard(spike: spike, isFresh: model.freshSpikeIds.contains(spike.id))
                            }
                            .buttonStyle(.plain)
                            .transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
                        }
                    }
                    .animation(.spring(response: 0.45, dampingFraction: 0.8), value: model.spikes.map(\.id))
                }
            }
        }
        .padding(.top, 6)
    }
}

struct Wordmark: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "waveform.path.ecg")
                .font(.system(size: 15, weight: .black))
                .foregroundStyle(Theme.accent)
            Text("ODDSHOT")
                .font(.system(size: 17, weight: .black, design: .rounded))
                .tracking(2)
                .foregroundStyle(.white)
        }
        .fixedSize()
    }
}

// MARK: - Gauge

struct VolatilityGauge: View {
    let value: Double
    let history: [VixPoint]
    @State private var shown: Double = 0

    private var clamped: Double { min(max(value, 0), 100) }
    private var mood: VolatilityIndex.Mood { VolatilityIndex.mood(clamped) }
    private var color: Color { Theme.mood(clamped) }

    var body: some View {
        VStack(spacing: 14) {
            HStack {
                SectionLabel(text: "Event Volatility Index", symbol: "gauge.with.dots.needle.67percent")
                Spacer()
                Badge(text: mood.rawValue.uppercased(), color: color, filled: true)
            }
            ZStack {
                // track: 270° arc
                Circle()
                    .trim(from: 0, to: 0.75)
                    .stroke(Color.white.opacity(0.07), style: StrokeStyle(lineWidth: 18, lineCap: .round))
                    .rotationEffect(.degrees(135))
                Circle()
                    .trim(from: 0, to: 0.75 * shown / 100)
                    .stroke(
                        AngularGradient(colors: [Theme.info, Theme.accent, Theme.notable, Theme.major],
                                        center: .center, startAngle: .degrees(0), endAngle: .degrees(270)),
                        style: StrokeStyle(lineWidth: 18, lineCap: .round))
                    .rotationEffect(.degrees(135))
                    .shadow(color: color.opacity(0.55), radius: 12)
                // zone dividers at 25 / 50 / 75
                ForEach(1..<4) { i in
                    Rectangle()
                        .fill(Theme.panel)
                        .frame(width: 3, height: 22)
                        .offset(y: -83)
                        .rotationEffect(.degrees(225 + 270 * Double(i) / 4))
                }
                VStack(spacing: 0) {
                    Text("\(Int(shown.rounded()))")
                        .font(.system(size: 58, weight: .black, design: .rounded))
                        .monospacedDigit()
                        .contentTransition(.numericText(value: shown))
                        .foregroundStyle(.white)
                    Text(mood.rawValue.uppercased())
                        .font(Theme.mono(13, .heavy)).tracking(3)
                        .foregroundStyle(color)
                        .contentTransition(.interpolate)
                }
            }
            .frame(width: 184, height: 184)
            .padding(.bottom, -24)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Event Volatility Index \(Int(clamped)), \(mood.rawValue)")

            if history.count > 2 {
                Chart(history, id: \.t) { p in
                    AreaMark(x: .value("t", p.t), y: .value("EVI", p.overall))
                        .foregroundStyle(LinearGradient(colors: [color.opacity(0.35), .clear], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("t", p.t), y: .value("EVI", p.overall))
                        .foregroundStyle(color)
                        .interpolationMethod(.monotone)
                }
                .chartYScale(domain: 0...max(100, (history.map(\.overall).max() ?? 0)))
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .frame(height: 34)
                HStack {
                    if let first = history.first { Text(first.t, format: .dateTime.hour().minute()) }
                    Spacer(); Text("now")
                }
                .font(Theme.mono(9)).foregroundStyle(Theme.faint)
            }
        }
        .onAppear { withAnimation(.spring(response: 1.2, dampingFraction: 0.85)) { shown = clamped } }
        .onChange(of: clamped) { _, v in withAnimation(.spring(response: 1.0, dampingFraction: 0.8)) { shown = v } }
    }
}

// MARK: - Category bars

struct CategoryBars: View {
    let byCategory: [MarketCategory: Double]

    private var rows: [(MarketCategory, Double)] {
        let cats = Set(MarketCategory.known.filter { $0.raw != "other" }).union(byCategory.keys)
        return cats.sorted().map { ($0, byCategory[$0] ?? 0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "By category", symbol: "square.stack.3d.up.fill")
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)], spacing: 12) {
                ForEach(rows, id: \.0) { cat, v in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 6) {
                            Image(systemName: cat.symbol)
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(Theme.mood(v))
                                .frame(width: 16)
                            Text(cat.label)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.85))
                                .lineLimit(1)
                            Spacer(minLength: 2)
                            Text("\(Int(v.rounded()))")
                                .font(Theme.mono(12, .bold))
                                .monospacedDigit()
                                .contentTransition(.numericText(value: v))
                                .foregroundStyle(Theme.mood(v))
                        }
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.white.opacity(0.06))
                                Capsule()
                                    .fill(LinearGradient(colors: [Theme.mood(v).opacity(0.5), Theme.mood(v)], startPoint: .leading, endPoint: .trailing))
                                    .frame(width: max(4, geo.size.width * min(v, 100) / 100))
                            }
                        }
                        .frame(height: 5)
                    }
                    .animation(.spring(response: 0.8), value: v)
                }
            }
        }
    }
}
