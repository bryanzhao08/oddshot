import SwiftUI

// MARK: - Insight card

struct InsightCard: View {
    let insight: Insight
    var isFresh = false
    @State private var glow = false
    @Environment(AppModel.self) private var model
    @AppStorage(Prefs.shotPersona) private var roleRaw = Persona.general.rawValue

    private var color: Color { insight.type.color }
    private var role: Persona { Persona(rawValue: roleRaw) ?? .general }
    private var rec: Recommendation? {
        model.recommendation(id: insight.id, marketId: insight.marketIds.first, insight.recommendations, role: role)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: insight.type.symbol)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(color)
                .frame(width: 36, height: 36)
                .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Badge(text: insight.type.label.uppercased(), color: color)
                    if insight.severity != .info {
                        Badge(text: insight.severity.label.uppercased(), color: Theme.severity(insight.severity),
                              filled: insight.severity == .major)
                    }
                    Spacer(minLength: 4)
                    Text(insight.createdAt, style: .relative)
                        .font(Theme.mono(10)).foregroundStyle(Theme.faint).lineLimit(1)
                }
                Text(insight.title)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if !insight.body.isEmpty {
                    Text(insight.body)
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.72))
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let ctx = insight.context { ContextChips(context: ctx) }
                if let rec { RecommendationView(rec: rec, role: role) }
                HStack(spacing: 5) {
                    Image(systemName: insight.category.symbol)
                    Text(insight.category.label)
                    if insight.marketIds.count > 1 { Text("· \(insight.marketIds.count) markets") }
                }
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.faint)
            }
        }
        .padding(14)
        .background(
            LinearGradient(colors: [color.opacity(0.1), Theme.panel], startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(glow ? color : Theme.stroke, lineWidth: glow ? 1.5 : 1)
        )
        .shadow(color: glow ? color.opacity(0.45) : .clear, radius: 12)
        .onAppear {
            guard isFresh else { return }
            glow = true
            withAnimation(.easeOut(duration: 2.5).delay(0.4)) { glow = false }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Briefing

struct BriefingCard: View {
    let briefing: Briefing
    var onOpen: (BriefingShift) -> Void = { _ in }
    @State private var expanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                HStack {
                    SectionLabel(text: "While you were away", symbol: "sun.horizon.fill")
                    Spacer()
                    if let g = briefing.generatedAt {
                        Text(g, style: .relative).font(Theme.mono(10)).foregroundStyle(Theme.faint)
                    }
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundStyle(Theme.dim)
                        .rotationEffect(.degrees(expanded ? 0 : -90))
                }
            }
            .buttonStyle(.plain)

            if !briefing.headline.isEmpty {
                Text(briefing.headline)
                    .font(.system(size: 18, weight: .heavy))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(briefing.bullets.prefix(3).enumerated()), id: \.offset) { _, b in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Circle().fill(Theme.accent).frame(width: 5, height: 5).offset(y: -2)
                            Text(b).font(.system(size: 13)).foregroundStyle(.white.opacity(0.8))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                if !briefing.biggestShifts.isEmpty {
                    VStack(spacing: 6) {
                        ForEach(briefing.biggestShifts.prefix(3)) { s in
                            Button { onOpen(s) } label: { shiftRow(s) }.buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
        .padding(16)
        .background(
            LinearGradient(colors: [Theme.accent.opacity(0.12), Theme.panel], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.accent.opacity(0.25)))
    }

    private func shiftRow(_ s: BriefingShift) -> some View {
        HStack(spacing: 8) {
            Text(s.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.9)).lineLimit(1)
            Spacer(minLength: 4)
            if let f = s.from, let t = s.to {
                Text("\(Format.pct(f)) → \(Format.pct(t))").font(Theme.mono(11)).foregroundStyle(Theme.dim)
            }
            ProbabilityChange(delta: s.delta, font: Theme.mono(12, .bold))
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contentShape(Rectangle())
    }
}

// MARK: - Stories

struct StoriesCarousel: View {
    let stories: [Story]
    var onOpen: (Story) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Stories", symbol: "text.book.closed.fill")
                .padding(.horizontal, 2)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 10) {
                    ForEach(stories) { s in
                        Button { onOpen(s) } label: { StoryCard(story: s) }
                            .buttonStyle(.plain)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .contentMargins(.horizontal, 2, for: .scrollContent)
        }
    }
}

struct StoryCard: View {
    let story: Story

    var body: some View {
        let color = story.direction.color
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: story.direction.symbol)
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(.black)
                    .frame(width: 22, height: 22)
                    .background(color, in: Circle())
                Badge(text: story.category.label.uppercased(), color: Theme.dim, symbol: story.category.symbol)
                Spacer(minLength: 2)
                if let u = story.updatedAt {
                    Text(u, style: .relative).font(Theme.mono(9)).foregroundStyle(Theme.faint).lineLimit(1)
                }
            }
            Text(story.title)
                .font(.system(size: 15, weight: .heavy))
                .foregroundStyle(.white)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            if !story.summary.isEmpty {
                Text(story.summary)
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
            VStack(spacing: 4) {
                ForEach(story.markets.prefix(3)) { m in
                    HStack(spacing: 6) {
                        Text(m.title).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.dim).lineLimit(1)
                        Spacer(minLength: 2)
                        ProbabilityChange(delta: m.delta, font: Theme.mono(11, .bold))
                    }
                }
                if story.markets.count > 3 {
                    Text("+\(story.markets.count - 3) more").font(Theme.mono(9)).foregroundStyle(Theme.faint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            HStack(spacing: 6) {
                Text("STRENGTH").font(Theme.mono(8, .heavy)).foregroundStyle(Theme.faint)
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.07))
                        Capsule().fill(color).frame(width: max(3, g.size.width * story.strength))
                    }
                }
                .frame(height: 4)
            }
        }
        .padding(14)
        .frame(width: 270, height: 210, alignment: .topLeading)
        .background(
            LinearGradient(colors: [color.opacity(0.13), Theme.panel], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.stroke))
    }
}
