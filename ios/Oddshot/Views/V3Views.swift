import SwiftUI

// MARK: - Role switcher (shared app-wide via @AppStorage)

struct RoleMenu: View {
    @AppStorage(Prefs.shotPersona) private var roleRaw = Persona.general.rawValue
    var compact = false
    private var role: Persona { Persona(rawValue: roleRaw) ?? .general }

    var body: some View {
        Menu {
            Picker("Role", selection: $roleRaw) {
                ForEach(Persona.allCases) { p in
                    Label(p.shotLabel, systemImage: p.shotSymbol).tag(p.rawValue)
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: role.shotSymbol)
                if !compact { Text(role.shotLabel) }
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .heavy))
            }
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(.black)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Theme.accent, in: Capsule())
            .fixedSize()
        }
        .sensoryFeedback(.selection, trigger: roleRaw)
        .accessibilityLabel("Role: \(role.shotLabel)")
    }
}

// MARK: - Recommendation panel

struct RecommendationView: View {
    let rec: Recommendation
    let role: Persona
    @State private var expanded = false

    private var confColor: Color {
        switch rec.confidence {
        case .high: Theme.up
        case .medium: Theme.notable
        case .low, .none: Theme.dim
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: role.shotSymbol)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.black)
                    .frame(width: 22, height: 22)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                Text(role == .general ? "YOUR MOVE" : "FOR \(role.label.uppercased())S")
                    .font(Theme.mono(9, .heavy)).tracking(1).foregroundStyle(Theme.accent)
                Spacer(minLength: 4)
                if let c = rec.confidence {
                    HStack(spacing: 3) {
                        ForEach(0..<3, id: \.self) { i in
                            Capsule().fill(i < level(c) ? confColor : Color.white.opacity(0.12)).frame(width: 8, height: 4)
                        }
                        Text(c.rawValue.uppercased()).font(Theme.mono(8, .heavy)).foregroundStyle(confColor)
                    }
                    .accessibilityLabel("\(c.rawValue) confidence")
                }
                SourceBadge(rec: rec)
            }
            if !rec.headline.isEmpty {
                Text(rec.headline)
                    .font(.system(size: 15, weight: .heavy))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !rec.action.isEmpty {
                Label {
                    Text(rec.action).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "arrow.forward.circle.fill").foregroundStyle(Theme.accent)
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.88))
            }
            if !rec.reasoning.isEmpty {
                Button {
                    withAnimation(.snappy) { expanded.toggle() }
                } label: {
                    HStack(spacing: 4) {
                        Text(expanded ? "Hide reasoning" : "Why?")
                        Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .font(Theme.mono(10, .bold))
                    .foregroundStyle(Theme.dim)
                }
                .buttonStyle(.borderless)
                if expanded {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(rec.reasoning.prefix(4).enumerated()), id: \.offset) { _, r in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("•").foregroundStyle(Theme.accent)
                                Text(r).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.72))
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            if let d = rec.disclaimer ?? (role == .trader ? "Signal, not financial advice." : nil) {
                Text(d).font(.system(size: 10, weight: .medium)).italic().foregroundStyle(Theme.faint)
            }
        }
        .padding(10)
        .background(Theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.accent.opacity(0.25)))
        .animation(.snappy, value: rec)
    }

    private func level(_ c: Recommendation.Confidence) -> Int {
        switch c { case .low: 1; case .medium: 2; case .high: 3 }
    }
}

struct SourceBadge: View {
    let rec: Recommendation
    var body: some View {
        if rec.isClaude {
            Badge(text: "CLAUDE", color: Theme.orange, symbol: "sparkle")
                .accessibilityLabel("Written by Claude\(rec.model.map { " (\($0))" } ?? "")")
        } else {
            Badge(text: "RULES", color: Theme.dim, symbol: "gearshape.fill")
        }
    }
}

// MARK: - Live context chips

struct ContextChips: View {
    let context: LiveContext

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                switch context.kind {
                case .game: gameChips
                case .asset: assetChips
                case .other: EmptyView()
                }
            }
        }
        .scrollClipDisabled()
    }

    @ViewBuilder private var gameChips: some View {
        if let imm = context.imminent {
            ImminentBadge(imminent: imm)
        }
        if let league = context.league { chip(league.uppercased(), symbol: "sportscourt.fill", color: Theme.dim) }
        if context.status == "in" {
            chip("IN PLAY", symbol: "dot.radiowaves.left.and.right", color: Theme.major)
        } else if context.status == "post" {
            chip("FINAL", symbol: "flag.checkered", color: Theme.dim)
        } else if context.status == "pre" {
            chip("PRE-GAME", symbol: "clock", color: Theme.sky)
        }
        if let line = context.score?.line { chip(line, symbol: "number", color: .white) }
        if let clock = [context.period.map { periodLabel($0) }, context.clock].compactMap({ $0 }).joined(separator: " ").nilIfEmpty {
            chip(clock, symbol: "timer", color: Theme.dim)
        }
        if let s = context.situation { chip(s, symbol: "figure.american.football", color: Theme.notable) }
    }

    @ViewBuilder private var assetChips: some View {
        if let p = context.price {
            chip("\(context.symbol?.uppercased() ?? "SPOT") \(p.formatted(.currency(code: "USD").precision(.fractionLength(p < 10 ? 4 : p < 1000 ? 2 : 0))))",
                 symbol: "dollarsign.circle.fill", color: .white)
        }
        if let c = context.change5m { pctChip(c, "5m") }
        if let c = context.change1h { pctChip(c, "1h") }
    }

    private func periodLabel(_ p: String) -> String {
        Int(p) != nil ? "P\(p)" : p
    }

    private func pctChip(_ v: Double, _ label: String) -> some View {
        // change is a fraction (0.012) or a percentage (1.2); treat |v| < 1 as a fraction.
        let pct = abs(v) < 1 ? v * 100 : v
        return chip(String(format: "%@%.2f%% %@", pct >= 0 ? "+" : "−", abs(pct), label),
                    symbol: pct >= 0 ? "arrow.up.right" : "arrow.down.right", color: Theme.move(pct))
    }

    private func chip(_ text: String, symbol: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol).font(.system(size: 9, weight: .bold))
            Text(text).lineLimit(1)
        }
        .font(Theme.mono(10, .bold))
        .foregroundStyle(color)
        .padding(.horizontal, 7).padding(.vertical, 4)
        .background(Color.white.opacity(0.06), in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.stroke))
    }
}

struct ImminentBadge: View {
    let imminent: Imminent
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 9, weight: .black))
            Text("IMMINENT").font(Theme.mono(10, .heavy))
            if !imminent.label.isEmpty {
                Text("· \(imminent.label)").font(Theme.mono(10, .bold)).lineLimit(1)
            }
            if let c = imminent.confidence { Text("\(Int((c * 100).rounded()))%").font(Theme.mono(10, .heavy)) }
        }
        .foregroundStyle(.black)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Theme.major, in: Capsule())
        .shadow(color: Theme.major.opacity(pulse ? 0.8 : 0.1), radius: pulse ? 8 : 2)
        .animation(.easeInOut(duration: 0.9).repeatForever(), value: pulse)
        .onAppear { pulse = true }
        .accessibilityLabel("Imminent: \(imminent.label)")
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
