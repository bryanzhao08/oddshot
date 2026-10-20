import SwiftUI
import Charts

enum Theme {
    static let dusk = Color(hex: 0x141A3A)
    static let indigo = Color(hex: 0x2B2F8F)
    static let orchid = Color(hex: 0x8A3FD1)
    static let ember = Color(hex: 0xFF6A3D)
    static let gold = Color(hex: 0xFFC24B)
    static let mist = Color(hex: 0xF5F3FF)
    static let soft = Color(hex: 0xF5F3FF).opacity(0.68)
    static let up = Color(hex: 0x5BE7C4)
    static let down = Color(hex: 0xFF7A8A)

    /// Big numbers and the top pick: SF Pro, expanded width.
    static func display(_ size: CGFloat, _ weight: Font.Weight = .heavy) -> Font {
        .system(size: size, weight: weight).width(.expanded)
    }

    /// 0 = nothing going on, 1 = something is about to swing hard.
    static func heat(_ items: [WatchItem]) -> Double {
        min(Double(items.first?.expectedPts ?? 0) / 25, 1)
    }

    static func swingColor(_ pts: Int) -> Color { pts >= 15 ? gold : pts >= 6 ? .white : soft }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    /// Linear mix toward `other` (works back to iOS 17).
    func blend(_ other: Color, _ t: Double) -> Color {
        var a: (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0), b = a
        UIColor(self).getRed(&a.0, green: &a.1, blue: &a.2, alpha: &a.3)
        UIColor(other).getRed(&b.0, green: &b.1, blue: &b.2, alpha: &b.3)
        let k = CGFloat(min(max(t, 0), 1))
        return Color(red: a.0 + (b.0 - a.0) * k, green: a.1 + (b.1 - a.1) * k, blue: a.2 + (b.2 - a.2) * k)
    }
}

// MARK: - The sky: a slow mesh gradient that warms up as things heat up

struct HeatSky: View {
    var heat: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let warm = Theme.ember.blend(Theme.gold, 0.3)
        let mid = Theme.indigo.blend(Theme.orchid, heat)
        let glow = Theme.orchid.blend(warm, heat)
        Group {
            if #available(iOS 18, *) {
                TimelineView(.animation(minimumInterval: 1 / 20, paused: reduceMotion)) { ctx in
                    let t = reduceMotion ? 0 : ctx.date.timeIntervalSinceReferenceDate / 6
                    let wobble = Float(sin(t)) * 0.08, wobble2 = Float(cos(t * 0.7)) * 0.07
                    MeshGradient(
                        width: 3, height: 3,
                        points: [
                            [0, 0], [0.5, 0], [1, 0],
                            [0, 0.45 + wobble], [0.5 + wobble2, 0.5 - wobble], [1, 0.55 + wobble2],
                            [0, 1], [0.5, 1], [1, 1],
                        ],
                        colors: [
                            Theme.dusk, mid, Theme.dusk,
                            mid, glow, Theme.indigo.blend(Theme.dusk, 0.4),
                            glow.blend(Theme.dusk, 0.35), Theme.dusk, mid.blend(Theme.dusk, 0.5),
                        ]
                    )
                }
            } else {
                LinearGradient(colors: [Theme.dusk, mid, glow], startPoint: .top, endPoint: .bottom)
            }
        }
        .animation(.easeInOut(duration: 2), value: heat)
        .ignoresSafeArea()
    }
}

// MARK: - Liquid Glass (iOS 26) with a material fallback

extension View {
    @ViewBuilder
    func glass(_ radius: CGFloat = 22, tint: Color? = nil, interactive: Bool = false) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        if #available(iOS 26, *) {
            self.glassEffect(Glass.regular.tint(tint).interactive(interactive), in: shape)
        } else {
            self.background(.ultraThinMaterial, in: shape)
                .background(tint?.opacity(0.25) ?? .clear, in: shape)
                .overlay(shape.strokeBorder(.white.opacity(0.12)))
        }
    }

    @ViewBuilder
    func glassButton(prominent: Bool = false) -> some View {
        if #available(iOS 26, *) {
            if prominent { self.buttonStyle(.glassProminent) } else { self.buttonStyle(.glass) }
        } else {
            self.buttonStyle(.borderedProminent)
        }
    }

    /// Sheets get the system glass on iOS 26; older systems get the dusk color.
    @ViewBuilder
    func sheetBackground() -> some View {
        if #available(iOS 26, *) { self } else { self.presentationBackground(Theme.dusk) }
    }
}

struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 10
    @ViewBuilder var content: Content
    var body: some View {
        if #available(iOS 26, *) {
            GlassEffectContainer(spacing: spacing) { VStack(alignment: .leading, spacing: spacing) { content } }
        } else {
            VStack(alignment: .leading, spacing: spacing) { content }
        }
    }
}

// MARK: - Small pieces

struct Sparkline: View {
    var points: [PricePoint]
    var lineWidth: CGFloat = 2
    var body: some View {
        let up = (points.last?.p ?? 0) >= (points.first?.p ?? 0)
        Chart(points, id: \.t) { pt in
            LineMark(x: .value("t", pt.t), y: .value("p", pt.p))
                .interpolationMethod(.monotone)
                .lineStyle(StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .foregroundStyle(up ? Theme.up : Theme.down)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: .automatic(includesZero: false))
        .accessibilityHidden(true)
    }
}

struct LiveDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(Theme.down).frame(width: 7, height: 7).opacity(on ? 1 : 0.35)
            Text("Live").font(.caption.weight(.semibold))
        }
        .foregroundStyle(Theme.mist)
        .onAppear {
            guard !reduceMotion else { on = true; return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever()) { on = true }
        }
    }
}
