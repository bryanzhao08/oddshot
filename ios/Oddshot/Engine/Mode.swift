import Foundation

/// Who you are right now. Decides which markets matter and how alerts are worded.
enum Mode: String, CaseIterable, Codable, Sendable, Identifiable {
    case sports, out, markets, news, creator, everything

    var id: String { rawValue }

    var emoji: String {
        switch self {
        case .sports: "🏟️"
        case .out: "🍻"
        case .markets: "📈"
        case .news: "🗞️"
        case .creator: "📸"
        case .everything: "🌐"
        }
    }

    /// SF Symbol for the UI (notifications keep the emoji).
    var symbol: String {
        switch self {
        case .sports: "sportscourt.fill"
        case .out: "wineglass.fill"
        case .markets: "chart.line.uptrend.xyaxis"
        case .news: "newspaper.fill"
        case .creator: "camera.fill"
        case .everything: "globe"
        }
    }

    var name: String {
        switch self {
        case .sports: "Watching sports"
        case .out: "Out & about"
        case .markets: "Markets & crypto"
        case .news: "News junkie"
        case .creator: "Shooting or covering"
        case .everything: "A bit of everything"
        }
    }

    var blurb: String {
        switch self {
        case .sports: "On the couch or at the game. Tell me when a game is about to get good."
        case .out: "At a bar, a party, in line for the bathroom. Only buzz me when a live game is about to swing."
        case .markets: "Crypto, the Fed, stocks. Tell me when odds start moving fast."
        case .news: "Politics, tech, culture. Tell me when something's brewing before it's a headline."
        case .creator: "Photographer, streamer or journalist at an event. Tell me when to be ready."
        case .everything: "Only the biggest moments, whatever they're about."
        }
    }

    var categories: Set<Category> {
        switch self {
        case .sports, .out: [.sports]
        case .markets: [.crypto, .economics]
        case .news: [.politics, .tech, .entertainment, .weather, .other]
        case .creator: [.sports, .entertainment, .politics]
        case .everything: Set(Category.allCases)
        }
    }

    /// Only live / about-to-start events count (you can't run back to the TV for a 2028 election).
    var liveOnly: Bool { self == .out || self == .sports || self == .creator }

    /// Scales the alert bar: >1 = pickier.
    var pickiness: Double {
        switch self {
        case .out: 1.4
        case .everything: 1.3
        case .creator, .sports: 1.0
        case .markets, .news: 0.9
        }
    }

    func cares(about m: Market) -> Bool {
        guard categories.contains(m.category) else { return false }
        return liveOnly ? (m.live || m.startsSoon) : true
    }

    // MARK: wording

    /// Heads-up before it happens.
    func headsUp(_ m: Market, chance: Int) -> (title: String, body: String) {
        let t = m.shortTitle
        switch self {
        case .sports: return ("📺 \(t) is heating up", "\(chance)% chance of a big swing in the next 30 min. Worth watching.")
        case .out: return ("🍻 Head back to the TV", "\(t) is about to get interesting (\(chance)% chance of a big swing in 30 min).")
        case .markets: return ("📈 \(t) is getting jumpy", "\(chance)% chance the odds move 5+ pts in 30 min. Signal, not financial advice.")
        case .news: return ("🗞️ Something's brewing", "\(t): \(chance)% chance of a big move in the next 30 min.")
        case .creator: return ("📸 Get ready: \(t)", "A big moment is likely soon (\(chance)% in 30 min). Get in position.")
        case .everything: return ("👀 Keep an eye on \(t)", "\(chance)% chance of a big swing in the next 30 min.")
        }
    }

    /// It just happened.
    func happening(_ m: Market, deltaPts: Double, minutes: Int) -> (title: String, body: String) {
        let pts = Int(abs(deltaPts).rounded())
        let dir = deltaPts > 0 ? "up" : "down"
        let now = Int((m.probability * 100).rounded())
        let move = "\(m.sideLabel) \(dir) \(pts) pts to \(now)% in \(max(minutes, 1)) min"
        let t = m.shortTitle
        switch self {
        case .sports: return ("⚡ Big moment: \(t)", "\(move). Something just happened.")
        case .out: return ("🍻 You're missing something", "\(t): \(move).")
        case .markets: return ("📈 \(t) is moving", "\(move). Signal, not financial advice.")
        case .news: return ("🗞️ Odds just moved: \(t)", "\(move). News may be breaking.")
        case .creator: return ("📸 It's happening: \(t)", "\(move). Shoot now.")
        case .everything: return ("⚡ \(t)", "\(move).")
        }
    }

    /// X chatter about this market suddenly spiked.
    func xBuzz(_ m: Market, surge: Double) -> (title: String, body: String) {
        let x = "\(Int(surge.rounded()))×"
        switch self {
        case .out: return ("🍻 Everyone's talking about \(m.shortTitle)", "Posts on X just jumped \(x). Something's happening. Find a screen.")
        case .markets: return ("📈 X is buzzing: \(m.shortTitle)", "Posts jumped \(x) in 5 min. Odds may follow. Signal, not financial advice.")
        case .creator: return ("📸 X is lighting up: \(m.shortTitle)", "Posts jumped \(x) in 5 min. Be ready.")
        default: return ("💬 X is buzzing about \(m.shortTitle)", "Posts jumped \(x) in the last 5 minutes. Something may be happening.")
        }
    }
}
