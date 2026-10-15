import SwiftUI

// Iconography + color for v2 types (kept out of the Foundation-only model files).

extension Theme {
    static let violet = Color(red: 0.66, green: 0.48, blue: 1.0)
    static let teal = Color(red: 0.18, green: 0.88, blue: 0.82)
    static let orange = Color(red: 1.0, green: 0.52, blue: 0.20)
    static let sky = Color(red: 0.42, green: 0.66, blue: 1.0)
}

extension ShotKind {
    var symbol: String {
        switch self {
        case .tension: "flame.fill"
        case .turningPoint: "arrow.triangle.2.circlepath"
        case .decisive: "flag.checkered"
        case .closing: "hourglass"
        case .upcoming: "calendar.badge.clock"
        case .momentum: "wind"
        case .other: "scope"
        }
    }
    var color: Color {
        switch self {
        case .tension: Theme.orange
        case .turningPoint: Theme.violet
        case .decisive: Theme.up
        case .closing: Theme.major
        case .upcoming: Theme.sky
        case .momentum: Theme.teal
        case .other: Theme.accent
        }
    }
}

extension InsightType {
    var symbol: String {
        switch self {
        case .leadChange: "arrow.left.arrow.right"
        case .upsetBrewing: "exclamationmark.triangle.fill"
        case .lockIn: "lock.fill"
        case .calmBeforeStorm: "cloud.bolt.fill"
        case .beliefShift: "sparkles"
        case .story: "text.book.closed.fill"
        case .divergence: "arrow.triangle.branch"
        case .other: "lightbulb.fill"
        }
    }
    var color: Color {
        switch self {
        case .leadChange: Theme.violet
        case .upsetBrewing: Theme.orange
        case .lockIn: Theme.up
        case .calmBeforeStorm: Theme.sky
        case .beliefShift: Theme.accent
        case .story: Theme.teal
        case .divergence: Theme.major
        case .other: Theme.info
        }
    }
}

extension Story.Direction {
    var symbol: String {
        switch self {
        case .up: "arrow.up.right"
        case .down: "arrow.down.right"
        case .mixed: "arrow.up.arrow.down"
        }
    }
    var color: Color {
        switch self {
        case .up: Theme.up
        case .down: Theme.down
        case .mixed: Theme.notable
        }
    }
}

/// Circular 0–100 score ring.
struct ScoreRing: View {
    let score: Double
    var color: Color = Theme.accent
    var lineWidth: CGFloat = 5
    var caption: String? = "DRAMA"

    private var clamped: Double { min(max(score, 0), 100) }

    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.08), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: clamped / 100)
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .shadow(color: color.opacity(0.5), radius: 4)
                .animation(.spring(response: 0.8), value: clamped)
            VStack(spacing: -1) {
                Text("\(Int(clamped.rounded()))")
                    .font(.system(size: 17, weight: .black, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: clamped))
                    .foregroundStyle(.white)
                if let caption {
                    Text(caption).font(Theme.mono(7, .heavy)).tracking(0.6).foregroundStyle(Theme.faint)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(caption?.capitalized ?? "Score") \(Int(clamped))")
    }
}

/// "64% chance of a 5+ pt swing in 30 min" with a bar.
struct ForecastMeter: View {
    let forecast: Forecast
    var color: Color = Theme.accent
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(Format.pct(forecast.pMove30))
                    .font(.system(size: compact ? 18 : 24, weight: .black, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(color)
                    .contentTransition(.numericText(value: forecast.pMove30))
                Text("chance of a 5+ pt swing in 30 min")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.07))
                    Capsule()
                        .fill(LinearGradient(colors: [color.opacity(0.5), color], startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(4, g.size.width * min(max(forecast.pMove30, 0), 1)))
                }
            }
            .frame(height: 5)
            .animation(.spring(response: 0.8), value: forecast.pMove30)
            HStack(spacing: 6) {
                if let e = forecast.expectedMovePts, e > 0 {
                    Text("±\(e < 10 ? String(format: "%.1f", e) : String(Int(e.rounded()))) pts expected")
                }
                Spacer(minLength: 0)
                Text(forecast.isHeuristic ? "heuristic" : "ML forecast")
            }
            .font(Theme.mono(9, .semibold))
            .foregroundStyle(Theme.faint)
        }
        .accessibilityElement(children: .combine)
    }
}

enum Countdown {
    static func short(_ interval: TimeInterval) -> String {
        let s = max(0, Int(interval))
        if s >= 86_400 { return "\(s / 86_400)d \((s % 86_400) / 3600)h" }
        if s >= 3600 { return "\(s / 3600)h \((s % 3600) / 60)m" }
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
