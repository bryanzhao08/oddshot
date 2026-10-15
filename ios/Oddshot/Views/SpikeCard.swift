import SwiftUI

struct SpikeCard: View {
    let spike: Spike
    var isFresh = false
    @State private var glow = false
    @Environment(AppModel.self) private var model
    @AppStorage(Prefs.shotPersona) private var roleRaw = Persona.general.rawValue

    private var role: Persona { Persona(rawValue: roleRaw) ?? .general }
    /// Volatility spikes get their own violet identity regardless of severity.
    private var sevColor: Color { spike.isVolatility ? Theme.violet : Theme.severity(spike.severity) }
    private var rec: Recommendation? {
        model.recommendation(id: spike.id, marketId: spike.marketId, spike.recommendations, role: role)
    }

    var body: some View {
        HStack(spacing: 0) {
            Rectangle().fill(sevColor).frame(width: 4)
            VStack(alignment: .leading, spacing: 10) {
                // Top meta row
                HStack(spacing: 6) {
                    if spike.isVolatility {
                        Badge(text: "VOLATILITY", color: Theme.violet, filled: true, symbol: "waveform.path")
                        Badge(text: spike.severity.label.uppercased(), color: Theme.severity(spike.severity))
                    } else {
                        Badge(text: spike.severity.label.uppercased(), color: sevColor, filled: spike.severity == .major)
                    }
                    if spike.live { LiveBadge() }
                    if spike.demo { Badge(text: "DEMO", color: .white.opacity(0.7)) }
                    if !spike.matchedSubscriptions.isEmpty { Badge(text: "MATCH", color: Theme.accent, symbol: "bell.fill") }
                    Spacer(minLength: 4)
                    Text(spike.detectedAt, style: .relative)
                        .font(Theme.mono(10))
                        .foregroundStyle(Theme.faint)
                        .lineLimit(1)
                }

                // Title + outcome
                VStack(alignment: .leading, spacing: 3) {
                    Text(spike.title)
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.leading)
                        .lineLimit(3)
                    HStack(spacing: 5) {
                        Image(systemName: spike.category.symbol).font(.system(size: 10))
                        Text("\(spike.outcome) · \(spike.category.label) · \(Market.sourceLabel(spike.source))")
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.dim)
                    .lineLimit(1)
                }

                // Numbers
                HStack(alignment: .lastTextBaseline, spacing: 10) {
                    HStack(alignment: .lastTextBaseline, spacing: 6) {
                        Text(Format.pct(spike.from))
                            .font(Theme.mono(15, .semibold))
                            .foregroundStyle(Theme.dim)
                        Image(systemName: "arrow.right")
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundStyle(Theme.faint)
                        Text(Format.pct(spike.to))
                            .font(Theme.mono(22, .heavy))
                            .foregroundStyle(.white)
                            .contentTransition(.numericText(value: spike.to))
                    }
                    Spacer()
                    if spike.isVolatility, let r = spike.volRatio {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(String(format: "%.1f× vol", r))
                                .font(.system(size: 22, weight: .black, design: .rounded))
                                .foregroundStyle(Theme.violet)
                            Text("\(spike.signedPoints) pts net · \(spike.windowLabel)")
                                .font(Theme.mono(10))
                                .foregroundStyle(Theme.faint)
                        }
                    } else {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text("\(spike.signedPoints) pts")
                            .font(.system(size: 22, weight: .black, design: .rounded))
                            .foregroundStyle(Theme.move(spike.delta))
                            .contentTransition(.numericText(value: spike.delta))
                        Text("in \(spike.windowLabel)")
                            .font(Theme.mono(10))
                            .foregroundStyle(Theme.faint)
                    }
                    }
                }
                if spike.isVolatility {
                    Text("This market just started thrashing" + (spike.volRatio.map { String(format: " — volatility %.1f× its baseline", $0) } ?? "") + ", before the price has picked a direction.")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.violet.opacity(0.9))
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let ctx = spike.context { ContextChips(context: ctx) }
                if let rec { RecommendationView(rec: rec, role: role) }

                if let ml = spike.ml, let p = ml.pReal { MLSignalRow(ml: ml, pReal: p) }
            }
            .padding(14)
        }
        .background(
            LinearGradient(colors: [sevColor.opacity(spike.isVolatility ? 0.18 : spike.severity == .major ? 0.16 : 0.07), Theme.panel],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(glow ? sevColor : Theme.stroke, lineWidth: glow ? 1.5 : 1)
        )
        .overlay {
            if spike.isVolatility {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Theme.violet.opacity(0.7), style: StrokeStyle(lineWidth: 1.2, dash: [5, 4]))
            }
        }
        .shadow(color: glow ? sevColor.opacity(0.5) : .clear, radius: 14)
        .onAppear {
            guard isFresh else { return }
            glow = true
            withAnimation(.easeOut(duration: 2.5).delay(0.4)) { glow = false }
        }
        .accessibilityElement(children: .combine)
    }
}

struct MLSignalRow: View {
    let ml: MLSignal
    let pReal: Double

    private var color: Color { pReal >= 0.7 ? Theme.up : pReal >= 0.4 ? Theme.notable : Theme.dim }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "brain.head.profile").font(.system(size: 11, weight: .bold))
                Text("Signal \(Int((pReal * 100).rounded()))% real")
                    .font(Theme.mono(12, .bold))
                    .contentTransition(.numericText(value: pReal))
                if let label = ml.label, !label.isEmpty {
                    Text(label.uppercased()).font(Theme.mono(9, .heavy)).foregroundStyle(color.opacity(0.8))
                }
                Spacer()
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.08))
                        Capsule().fill(color).frame(width: g.size.width * min(max(pReal, 0), 1))
                    }
                }
                .frame(width: 60, height: 5)
            }
            .foregroundStyle(color)
            if !ml.drivers.isEmpty {
                Text(ml.drivers.prefix(3).joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.faint)
                    .lineLimit(1)
            }
        }
        .padding(8)
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct SpikeCardPlaceholder: View {
    @State private var on = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            RoundedRectangle(cornerRadius: 4).frame(width: 90, height: 12)
            RoundedRectangle(cornerRadius: 4).frame(height: 16)
            RoundedRectangle(cornerRadius: 4).frame(width: 180, height: 12)
            HStack { RoundedRectangle(cornerRadius: 4).frame(width: 110, height: 20); Spacer(); RoundedRectangle(cornerRadius: 4).frame(width: 70, height: 20) }
        }
        .foregroundStyle(Color.white.opacity(on ? 0.09 : 0.04))
        .panel()
        .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { on = true } }
    }
}
