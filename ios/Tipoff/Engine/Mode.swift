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

    /// What to do about it, in this mode's voice.
    var nudge: String {
        switch self {
        case .sports: "Worth watching now."
        case .out: "Find a screen."
        case .markets: "Signal, not financial advice."
        case .news: "News may be breaking."
        case .creator: "Get in position."
        case .everything: ""
        }
    }

    /// Heads-up before it happens.
    func headsUp(_ m: Market, chance: Int, moment: GameMoment?) -> (title: String, body: String) {
        let name = m.split.name
        if let mo = moment { return ("\(mo.emoji) \(mo.headline)", "\(name): \(chance)% chance the odds jump 5%+ in the next 30 min. \(nudge)") }
        let title: String
        switch self {
        case .sports: title = "📺 \(name) is heating up"
        case .out: title = "🍻 Head back to the TV: \(name)"
        case .markets: title = "📈 \(name) is getting jumpy"
        case .news: title = "🗞️ Something's brewing: \(name)"
        case .creator: title = "📸 Get ready: \(name)"
        case .everything: title = "👀 Keep an eye on \(name)"
        }
        return (title, "\(chance)% chance the odds jump 5%+ in the next 30 min. \(nudge)")
    }

    /// It just happened. `move` reads like "Ann Li up from 42% to 60% in 3 min".
    func happening(_ m: Market, move: String, moment: GameMoment?) -> (title: String, body: String) {
        let name = m.split.name
        if let mo = moment { return ("\(mo.emoji) \(mo.headline)", "\(name): \(move). \(nudge)") }
        let title: String
        switch self {
        case .sports: title = "⚡ Big moment: \(name)"
        case .out: title = "🍻 You're missing something: \(name)"
        case .markets: title = "📈 \(name) is moving"
        case .news: title = "🗞️ Odds just moved: \(name)"
        case .creator: title = "📸 It's happening: \(name)"
        case .everything: title = "⚡ \(name)"
        }
        return (title, "\(move). \(nudge)")
    }

    /// X chatter about this market suddenly spiked.
    func xBuzz(_ m: Market, surge: Double, phrase: String?) -> (title: String, body: String) {
        let x = "\(Int(surge.rounded()))×"
        let what = phrase.map { "People are posting \"\($0)\"." } ?? "Something may be happening."
        return ("💬 X is buzzing about \(m.split.name)", "Posts jumped \(x) in 5 min. \(what) \(nudge)")
    }
}
