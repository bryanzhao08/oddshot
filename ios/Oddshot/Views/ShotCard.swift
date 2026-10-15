import SwiftUI

struct ShotCard: View {
    let shot: Shot
    let position: Int
    let persona: Persona
    var rankDelta: Int = 0
    var points: [PricePoint] = []
    var watching = false
    var recommendation: Recommendation?
    var onWatch: () -> Void = {}
    var onOpen: () -> Void = {}

    private var color: Color { shot.kind.color }
    private var market: Market? { shot.market }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            topRow
            VStack(alignment: .leading, spacing: 4) {
                Text(shot.headline)
                    .font(.system(size: 18, weight: .heavy))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let m = market {
                    HStack(spacing: 5) {
                        Image(systemName: m.category.symbol).font(.system(size: 10))
                        Text("\(m.title) · \(m.sourceLabel)")
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.dim)
                    .lineLimit(1)
                }
            }

            HStack(alignment: .center, spacing: 14) {
                ScoreRing(score: shot.dramaScore, color: color)
                    .frame(width: 56, height: 56)
                if let f = shot.forecast {
                    ForecastMeter(forecast: f, color: color)
                } else {
                    Text("Forecast warming up…")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.faint)
                    Spacer()
                }
            }

            if let ctx = shot.context { ContextChips(context: ctx) }

            if let recommendation {
                RecommendationView(rec: recommendation, role: persona)
            } else if let tip = shot.tips.tip(for: persona) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: persona.shotSymbol)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.black)
                        .frame(width: 26, height: 26)
                        .background(Theme.accent, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(persona == .general ? "YOUR MOVE" : "FOR \(persona.label.uppercased())S")
                            .font(Theme.mono(9, .heavy)).tracking(1).foregroundStyle(Theme.accent)
                        Text(tip)
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.white)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                .padding(10)
                .background(Theme.accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.accent.opacity(0.25)))
            }

            if !shot.why.isEmpty {
                Label {
                    Text(shot.why).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "questionmark.bubble.fill").foregroundStyle(color)
                }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.75))
            }

            HStack(alignment: .center, spacing: 12) {
                Sparkline(points: points, delta: market?.change1h ?? ((points.last?.p ?? 0) - (points.first?.p ?? 0)))
                    .frame(height: 30)
                    .frame(maxWidth: .infinity)
                if let m = market {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(Format.pct(m.probability))
                            .font(Theme.mono(16, .heavy)).foregroundStyle(.white)
                            .contentTransition(.numericText(value: m.probability))
                        if let c = m.change1h { ProbabilityChange(delta: c, font: Theme.mono(10, .bold)) }
                    }
                }
                WindowCountdown(window: shot.window, color: color)
            }

            actions
        }
        .padding(14)
        .background(
            LinearGradient(colors: [color.opacity(position == 1 ? 0.2 : 0.1), Theme.panel],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(position == 1 ? color.opacity(0.6) : Theme.stroke, lineWidth: position == 1 ? 1.5 : 1))
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onTapGesture(perform: onOpen)
    }

    private var topRow: some View {
        HStack(spacing: 6) {
            Text("#\(position)")
                .font(.system(size: 20, weight: .black, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(position <= 3 ? color : Theme.dim)
                .contentTransition(.numericText(value: Double(position)))
            Badge(text: shot.kind.label.uppercased(), color: color, filled: true, symbol: shot.kind.symbol)
            if market?.live == true { LiveBadge() }
            if rankDelta != 0 {
                HStack(spacing: 2) {
                    Image(systemName: rankDelta > 0 ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
                    Text("\(abs(rankDelta))")
                }
                .font(Theme.mono(10, .heavy))
                .foregroundStyle(rankDelta > 0 ? Theme.up : Theme.down)
                .transition(.scale.combined(with: .opacity))
            }
            Spacer(minLength: 4)
            if watching {
                Image(systemName: "eye.fill").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.accent)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button(action: onWatch) {
                Label(watching ? "Watching" : "Watch", systemImage: watching ? "eye.fill" : "eye")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(watching ? Theme.panelHi : Theme.accent)
            .foregroundStyle(watching ? Theme.accent : .black)

            Button(action: onOpen) {
                Label("Details", systemImage: "chart.xyaxis.line").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.white)

            if let url = market?.url {
                Link(destination: url) {
                    Label(market?.sourceLabel ?? "Open", systemImage: "arrow.up.right.square")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.white)
            }
        }
        .font(.system(size: 12, weight: .bold))
        .labelStyle(.titleAndIcon)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
}

/// Live countdown to (or through) the shot's window.
struct WindowCountdown: View {
    let window: ShotWindow
    var color: Color = Theme.accent

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let (label, value, live) = describe(ctx.date)
            VStack(alignment: .trailing, spacing: 1) {
                Text(label)
                    .font(Theme.mono(8, .heavy)).tracking(0.8)
                    .foregroundStyle(live ? color : Theme.faint)
                Text(value)
                    .font(Theme.mono(14, .heavy))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .contentTransition(.numericText())
            }
            .frame(minWidth: 70, alignment: .trailing)
        }
    }

    private func describe(_ now: Date) -> (String, String, Bool) {
        if let s = window.startsAt, s > now { return ("STARTS IN", Countdown.short(s.timeIntervalSince(now)), false) }
        if let e = window.endsAt {
            if e > now { return ("WINDOW CLOSES", Countdown.short(e.timeIntervalSince(now)), true) }
            return ("WINDOW", "ended", false)
        }
        if let s = window.startsAt { return ("LIVE FOR", Countdown.short(now.timeIntervalSince(s)), true) }
        return ("WINDOW", "now", true)
    }
}

struct ShotCardPlaceholder: View {
    @State private var on = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            RoundedRectangle(cornerRadius: 4).frame(width: 120, height: 14)
            RoundedRectangle(cornerRadius: 4).frame(height: 20)
            HStack(spacing: 12) {
                Circle().frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 6) {
                    RoundedRectangle(cornerRadius: 4).frame(height: 16)
                    RoundedRectangle(cornerRadius: 4).frame(height: 6)
                }
            }
            RoundedRectangle(cornerRadius: 10).frame(height: 44)
        }
        .foregroundStyle(Color.white.opacity(on ? 0.09 : 0.04))
        .panel()
        .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { on = true } }
    }
}
