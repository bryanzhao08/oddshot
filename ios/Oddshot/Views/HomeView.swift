import SwiftUI

struct HomeView: View {
    @Environment(Watcher.self) private var watcher
    @State private var showModes = false
    @State private var showSettings = false
    @State private var showPicker = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    StatusLine()
                    FollowingSection(showPicker: $showPicker)
                    if let top = watcher.items.first {
                        Text("Keep an eye on").font(.title3.weight(.semibold)).padding(.top, 4)
                        TopPick(item: top)
                        if let pulse = watcher.xPulse { XPanel(pulse: pulse, topic: watcher.xTopic) }
                        else if let status = watcher.xStatus { Text(status).font(.footnote).foregroundStyle(Theme.soft) }
                        if watcher.items.count > 1 {
                            Text("Also heating up").font(.title3.weight(.semibold)).padding(.top, 10)
                            GlassGroup(spacing: 8) {
                                ForEach(watcher.items.dropFirst().prefix(6)) { WatchRow(item: $0) }
                            }
                        }
                    } else {
                        EmptyPick(loading: watcher.lastUpdate == nil)
                    }
                    if !watcher.moments.isEmpty {
                        Text("Recent alerts").font(.title3.weight(.semibold)).padding(.top, 10)
                        GlassGroup(spacing: 8) {
                            ForEach(watcher.moments.prefix(8)) { MomentRow(moment: $0) }
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 40)
            }
            .refreshable { await watcher.tick() }
            .scrollContentBackground(.hidden)
            .background { HeatSky(heat: Theme.heat(watcher.items)) }
            .foregroundStyle(Theme.mist)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showModes = true } label: {
                        HStack(spacing: 6) {
                            Image(systemName: watcher.mode.symbol)
                            Text(watcher.mode.name).font(.subheadline.weight(.semibold))
                            Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                        }
                        .padding(.horizontal, 6)
                        .foregroundStyle(Theme.mist)
                    }
                    .accessibilityIdentifier("modeButton")
                    .accessibilityLabel("Mode: \(watcher.mode.name). Change mode")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showPicker = true } label: { Image(systemName: "star").foregroundStyle(Theme.mist) }
                        .accessibilityIdentifier("pickMatches")
                        .accessibilityLabel("Pick your matches")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape").foregroundStyle(Theme.mist) }
                        .accessibilityIdentifier("settingsButton")
                        .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showModes) { ModeSheet() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showPicker) { MatchPicker() }
        }
    }
}

private struct StatusLine: View {
    @Environment(Watcher.self) private var watcher
    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { _ in
            Group {
                if watcher.offline {
                    Label("Can't reach Polymarket. Pull down to try again.", systemImage: "wifi.exclamationmark")
                } else if let t = watcher.lastUpdate {
                    Text("Live odds, updated \(t, format: .relative(presentation: .named))")
                } else {
                    Text("Loading live odds…")
                }
            }
            .font(.footnote)
            .foregroundStyle(watcher.offline ? Theme.down : Theme.soft)
        }
    }
}

// MARK: - The one thing to watch

private struct TopPick: View {
    var item: WatchItem

    var body: some View {
        let m = item.market
        let card = VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: m.category.symbol)
                Text(m.split.league ?? m.category.label).lineLimit(1)
                Spacer()
                if m.live { LiveDot() } else if m.startsSoon { Text("Starts soon").foregroundStyle(Theme.gold) }
                FollowStar(market: m)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.soft)

            Text(m.split.name)
                .font(Theme.display(24, .bold))
                .lineLimit(3)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("±\(item.expectedPts)")
                    .font(Theme.display(52))
                    .foregroundStyle(Theme.swingColor(item.expectedPts))
                    .contentTransition(.numericText())
                Text("points could swing\nin the next 30 min")
                    .font(.footnote)
                    .foregroundStyle(Theme.soft)
            }

            HStack(alignment: .bottom) {
                Text("\(m.sideLabel) \(Int((m.probability * 100).rounded()))%")
                    .font(.headline)
                Spacer()
                if item.recent.count > 2 { Sparkline(points: item.recent, lineWidth: 2.5).frame(width: 130, height: 40) }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass(28, tint: Theme.ember.opacity(0.18 * Theme.heat([item])), interactive: true)
        .accessibilityElement(children: .contain)

        card.contextMenu {
            if let url = m.url { Link(destination: url) { Label("Open on Polymarket", systemImage: "arrow.up.right.square") } }
        }
    }
}

private struct EmptyPick: View {
    var loading: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(loading ? "Checking the odds" : "All quiet")
                .font(Theme.display(26, .bold))
            Text(loading ? "This takes a few seconds the first time."
                         : "Nothing's about to swing right now. Leave the app open and we'll buzz you when something heats up.")
                .foregroundStyle(Theme.soft)
            if loading { ProgressView().tint(Theme.mist).padding(.top, 4) }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass(28)
        .padding(.top, 8)
    }
}

// MARK: - Following

/// Star = follow this match. Followed matches get alerts first, with a lower bar.
struct FollowStar: View {
    @Environment(Watcher.self) private var watcher
    var market: Market
    var body: some View {
        let on = watcher.isFollowed(market)
        Button {
            withAnimation(.snappy) { watcher.toggleFollow(market) }
        } label: {
            Image(systemName: on ? "star.fill" : "star")
                .font(.body.weight(.semibold))
                .foregroundStyle(on ? Theme.gold : Theme.soft)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: on)
        .accessibilityLabel(on ? "Unfollow \(market.split.name)" : "Follow \(market.split.name)")
    }
}

private struct FollowingSection: View {
    @Environment(Watcher.self) private var watcher
    @Binding var showPicker: Bool

    var body: some View {
        if watcher.followedItems.isEmpty {
            Button { showPicker = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: "star.fill").foregroundStyle(Theme.gold)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Pick your matches").font(.subheadline.weight(.semibold))
                        Text("Follow the games you care about and we'll watch them first.")
                            .font(.caption).foregroundStyle(Theme.soft).multilineTextAlignment(.leading)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(Theme.soft)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glass(18, interactive: true)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("pickMatchesCard")
        } else {
            HStack {
                Text("Following").font(.title3.weight(.semibold))
                Spacer()
                Button("Edit") { showPicker = true }.font(.subheadline.weight(.semibold)).foregroundStyle(Theme.gold)
            }
            .padding(.top, 4)
            GlassGroup(spacing: 8) {
                ForEach(watcher.followedItems) { WatchRow(item: $0) }
            }
        }
    }
}

/// Browse and search every match we're tracking; tap a star to follow.
struct MatchPicker: View {
    @Environment(Watcher.self) private var watcher
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var liveOnly = true

    var body: some View {
        let all = watcher.browse(query)
        let shown = liveOnly && query.isEmpty ? all.filter { $0.live || $0.startsSoon } : all
        NavigationStack {
            List {
                if shown.isEmpty {
                    Text(liveOnly && query.isEmpty ? "Nothing live right now. Turn off \"Live now\" to see everything."
                                                   : "No matches for \"\(query)\".")
                        .foregroundStyle(Theme.soft)
                }
                ForEach(shown.prefix(120)) { m in
                    HStack(spacing: 12) {
                        Image(systemName: m.category.symbol).foregroundStyle(Theme.soft).frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.split.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                            HStack(spacing: 6) {
                                if m.live { Text("Live").foregroundStyle(Theme.down) }
                                else if let s = m.startTime, s > .now { Text(s, format: .relative(presentation: .named)) }
                                if let league = m.split.league { Text(league).lineLimit(1) }
                            }
                            .font(.caption).foregroundStyle(Theme.soft)
                        }
                        Spacer()
                        FollowStar(market: m)
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Team, player or event")
            .navigationTitle("Pick your matches")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Toggle("Live now", isOn: $liveOnly).toggleStyle(.button).font(.subheadline.weight(.semibold))
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .sheetBackground()
    }
}

// MARK: - X chatter about the top pick

private struct XPanel: View {
    var pulse: XPulse
    var topic: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(pulse.isSpiking ? "X is buzzing" : "On X")\(topic.map { ": \($0)" } ?? "")")
                    .font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer()
                Text(pulse.posts.isEmpty ? "No recent posts"
                     : "\(String(format: "%.1f", pulse.perMinute)) posts/min\(pulse.surge >= 1.5 ? ", \(Int(pulse.surge.rounded()))× normal" : "")")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(pulse.isSpiking ? Theme.gold : Theme.soft)
            }
            ForEach(pulse.posts.prefix(3)) { post in
                VStack(alignment: .leading, spacing: 2) {
                    Text(post.text).font(.footnote).lineLimit(3)
                    Text("@\(post.author), \(post.date, format: .relative(presentation: .named))")
                        .font(.caption2).foregroundStyle(Theme.soft)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass(20, tint: pulse.isSpiking ? Theme.gold.opacity(0.2) : nil)
    }
}

// MARK: - Rows

private struct WatchRow: View {
    var item: WatchItem

    var body: some View {
        let m = item.market
        let row = HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(m.split.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                    if m.live { Circle().fill(Theme.down).frame(width: 6, height: 6).accessibilityLabel("Live") }
                }
                Text([m.split.league, "\(m.sideLabel) \(Int((m.probability * 100).rounded()))%"].compactMap { $0 }.joined(separator: ", "))
                    .font(.caption).foregroundStyle(Theme.soft).lineLimit(1)
            }
            Spacer(minLength: 6)
            if item.recent.count > 2 { Sparkline(points: item.recent, lineWidth: 1.5).frame(width: 52, height: 24) }
            Text("±\(item.expectedPts)")
                .font(Theme.display(18, .bold))
                .foregroundStyle(Theme.swingColor(item.expectedPts))
                .frame(minWidth: 46, alignment: .trailing)
                .accessibilityLabel("could swing \(item.expectedPts) points")
            FollowStar(market: m)
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .padding(.vertical, 8)
        .glass(18)

        row.contextMenu {
            if let url = m.url { Link(destination: url) { Label("Open on Polymarket", systemImage: "arrow.up.right.square") } }
        }
    }
}

struct MomentRow: View {
    var moment: Moment
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: moment.kind == .happening ? "bolt.fill" : "eye.fill")
                .foregroundStyle(moment.kind == .happening ? Theme.gold : Theme.up)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
                Text(moment.title).font(.subheadline.weight(.semibold))
                Text(moment.body).font(.footnote).foregroundStyle(Theme.soft)
                Text(moment.date, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(Theme.soft.opacity(0.8))
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .glass(18)
    }
}

// MARK: - Mode switcher

struct ModeSheet: View {
    @Environment(Watcher.self) private var watcher
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("What are you up to?").font(Theme.display(22, .bold)).padding(.top, 8)
                ModeGrid(selected: watcher.mode) { watcher.mode = $0; dismiss() }
            }
            .padding(20)
        }
        .presentationDetents([.large])
        .sheetBackground()
    }
}
