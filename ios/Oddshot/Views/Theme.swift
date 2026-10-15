import SwiftUI

enum Theme {
    static let bg = Color(red: 0.035, green: 0.039, blue: 0.051)
    static let panel = Color(red: 0.075, green: 0.082, blue: 0.10)
    static let panelHi = Color(red: 0.11, green: 0.12, blue: 0.145)
    static let stroke = Color.white.opacity(0.08)
    /// Signature "acid lime" accent.
    static let accent = Color(red: 0.776, green: 1.0, blue: 0.18)
    static let up = Color(red: 0.25, green: 0.95, blue: 0.55)
    static let down = Color(red: 1.0, green: 0.30, blue: 0.36)
    static let info = Color(red: 0.30, green: 0.75, blue: 1.0)
    static let notable = Color(red: 1.0, green: 0.71, blue: 0.16)
    static let major = Color(red: 1.0, green: 0.22, blue: 0.42)
    static let dim = Color.white.opacity(0.55)
    static let faint = Color.white.opacity(0.35)

    static func severity(_ s: Severity) -> Color {
        switch s { case .info: info; case .notable: notable; case .major: major }
    }
    static func move(_ d: Double) -> Color { d >= 0 ? up : down }
    static func mood(_ v: Double) -> Color {
        switch VolatilityIndex.mood(v) {
        case .calm: info
        case .active: accent
        case .heated: notable
        case .chaotic: major
        }
    }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

struct Panel: ViewModifier {
    var padding: CGFloat = 16
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.stroke))
    }
}

extension View {
    func panel(padding: CGFloat = 16) -> some View { modifier(Panel(padding: padding)) }

    /// Shared dark styling for each tab's NavigationStack root.
    func oddshotScreen() -> some View {
        self
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .toolbarColorScheme(.dark, for: .navigationBar)
    }
}

struct SectionLabel: View {
    let text: String
    var symbol: String?
    var body: some View {
        HStack(spacing: 6) {
            if let symbol { Image(systemName: symbol) }
            Text(text.uppercased())
        }
        .font(Theme.mono(11, .bold))
        .tracking(1.6)
        .foregroundStyle(Theme.dim)
    }
}

struct Badge: View {
    let text: String
    var color: Color = Theme.accent
    var filled = false
    var symbol: String?
    var body: some View {
        HStack(spacing: 3) {
            if let symbol { Image(systemName: symbol).font(.system(size: 8, weight: .black)) }
            Text(text)
        }
        .font(Theme.mono(10, .heavy))
        .tracking(0.8)
        .padding(.horizontal, 6).padding(.vertical, 3)
        .foregroundStyle(filled ? Color.black : color)
        .background(filled ? color : color.opacity(0.14), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

struct LiveBadge: View {
    @State private var pulse = false
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Theme.major).frame(width: 6, height: 6)
                .opacity(pulse ? 0.25 : 1)
                .animation(.easeInOut(duration: 0.8).repeatForever(), value: pulse)
            Text("LIVE")
        }
        .font(Theme.mono(10, .heavy)).tracking(0.8)
        .padding(.horizontal, 6).padding(.vertical, 3)
        .foregroundStyle(Theme.major)
        .background(Theme.major.opacity(0.14), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
        .onAppear { pulse = true }
    }
}

struct ConnectionPill: View {
    let state: ConnectionState
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
                .shadow(color: color, radius: state.isLive ? 4 : 0)
            Text(state.label.uppercased())
        }
        .font(Theme.mono(10, .bold))
        .foregroundStyle(color)
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(color.opacity(0.12), in: Capsule())
        .fixedSize()
        .animation(.default, value: state)
    }
    var color: Color {
        switch state {
        case .live: Theme.up
        case .connecting, .reconnecting: Theme.notable
        case .idle, .failed: Theme.down
        }
    }
}

struct StateMessage: View {
    let symbol: String
    let title: String
    var message: String?
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .symbolEffect(.pulse, options: .repeating)
            Text(title).font(.headline).foregroundStyle(.white)
            if let message {
                Text(message).font(.subheadline).foregroundStyle(Theme.dim).multilineTextAlignment(.center)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .foregroundStyle(.black)
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28).padding(.horizontal, 20)
    }
}

struct Toast: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.black)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Theme.accent, in: Capsule())
            .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
    }
}

struct ProbabilityChange: View {
    let delta: Double
    var font: Font = Theme.mono(13, .bold)
    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: delta >= 0 ? "arrow.up.right" : "arrow.down.right")
                .font(.system(size: 10, weight: .heavy))
            Text(Format.pts(delta, decimals: abs(delta) < 0.1))
                .contentTransition(.numericText(value: delta))
        }
        .font(font)
        .foregroundStyle(abs(delta) < 0.0005 ? Theme.dim : Theme.move(delta))
    }
}
