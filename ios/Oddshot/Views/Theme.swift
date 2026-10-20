import SwiftUI
import Charts

enum Theme {
    static let bg = Color(hex: 0x07090D)
    static let card = Color(hex: 0x10151D)
    static let line = Color(hex: 0x1F2834)
    static let muted = Color(hex: 0x8A97A8)
    static let accent = Color(hex: 0xC6FF3D)
    static let accentInk = Color(hex: 0x0D1400)
    static let up = Color(hex: 0x1FD67B)
    static let down = Color(hex: 0xFF4D6A)
    static let hot = Color(hex: 0xFFB020)
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

struct CardStyle: ViewModifier {
    var highlight: Color?
    func body(content: Content) -> some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(highlight?.opacity(0.5) ?? Theme.line))
    }
}

extension View {
    func card(highlight: Color? = nil) -> some View { modifier(CardStyle(highlight: highlight)) }
}

struct Sparkline: View {
    var points: [PricePoint]
    var body: some View {
        let up = (points.last?.p ?? 0) >= (points.first?.p ?? 0)
        Chart(points, id: \.t) { pt in
            LineMark(x: .value("t", pt.t), y: .value("p", pt.p))
                .interpolationMethod(.monotone)
                .foregroundStyle(up ? Theme.up : Theme.down)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: .automatic(includesZero: false))
    }
}

struct LivePill: View {
    @State private var on = false
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Theme.down).frame(width: 6, height: 6).opacity(on ? 1 : 0.3)
            Text("LIVE").font(.caption2.weight(.heavy))
        }
        .foregroundStyle(Theme.down)
        .onAppear { withAnimation(.easeInOut(duration: 0.8).repeatForever()) { on = true } }
    }
}

/// The swing the forecaster expects over the next 30 minutes, in points.
struct SwingChip: View {
    var pts: Int
    var color: Color { pts >= 10 ? Theme.hot : pts >= 4 ? Theme.accent : Theme.muted }
    var body: some View {
        VStack(spacing: 0) {
            Text("±\(pts)").font(.system(.headline, design: .rounded).weight(.bold)).monospacedDigit()
            Text("pts / 30m").font(.system(size: 9, weight: .medium)).foregroundStyle(Theme.muted)
        }
        .foregroundStyle(color)
        .frame(width: 60, height: 46)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityLabel("Expected swing \(pts) points in the next 30 minutes")
    }
}
