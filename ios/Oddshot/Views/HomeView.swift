import SwiftUI

struct HomeView: View {
    @Environment(Watcher.self) private var watcher
    @State private var showModes = false
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    StatusLine()
                    Text("Keep an eye on").font(.title2.weight(.bold)).padding(.top, 8)
                    if watcher.items.isEmpty {
                        Text(watcher.lastUpdate == nil ? "Checking the odds…" : "Nothing going on right now. We'll buzz you when something heats up.")
                            .foregroundStyle(Theme.muted).card()
                    } else {
                        ForEach(watcher.items.prefix(8)) { WatchRow(item: $0) }
                    }
                    if !watcher.moments.isEmpty {
                        Text("Recent alerts").font(.title2.weight(.bold)).padding(.top, 16)
                        ForEach(watcher.moments.prefix(10)) { MomentRow(moment: $0) }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .refreshable { await watcher.tick() }
            .background(Theme.bg.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showModes = true } label: {
                        HStack(spacing: 6) {
                            Text(watcher.mode.emoji)
                            Text(watcher.mode.name).font(.subheadline.weight(.semibold))
                            Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                        }
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Theme.accent, in: Capsule())
                        .foregroundStyle(Theme.accentInk)
                    }
                    .accessibilityIdentifier("modeButton")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape.fill") }
                        .foregroundStyle(Theme.muted)
                        .accessibilityIdentifier("settingsButton")
                }
            }
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .sheet(isPresented: $showModes) { ModeSheet() }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
    }
}

private struct StatusLine: View {
    @Environment(Watcher.self) private var watcher
    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { _ in
            HStack(spacing: 6) {
                Circle().fill(watcher.offline ? Theme.down : Theme.up).frame(width: 7, height: 7)
                if watcher.offline {
                    Text("Can't reach Polymarket. Check your connection.")
                } else if let t = watcher.lastUpdate {
                    Text("Live odds · updated \(t, format: .relative(presentation: .named))")
                } else {
                    Text("Loading live odds…")
                }
            }
            .font(.footnote)
            .foregroundStyle(Theme.muted)
        }
    }
}

private struct WatchRow: View {
    var item: WatchItem

    var body: some View {
        let m = item.market
        let row = HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Image(systemName: m.category.symbol).font(.caption)
                    Text(m.category.label).font(.caption.weight(.semibold))
                    if m.live { LivePill() } else if m.startsSoon { Text("STARTS SOON").font(.caption2.weight(.heavy)).foregroundStyle(Theme.hot) }
                }
                .foregroundStyle(Theme.muted)
                Text(m.shortTitle).font(.headline).lineLimit(2).foregroundStyle(.white).multilineTextAlignment(.leading)
                Text("\(m.sideLabel) \(Int((m.probability * 100).rounded()))%")
                    .font(.subheadline.weight(.medium)).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 4)
            if item.recent.count > 2 { Sparkline(points: item.recent).frame(width: 56, height: 30) }
            SwingChip(pts: item.expectedPts)
        }
        .card(highlight: item.expectedPts >= 10 ? Theme.hot : nil)

        if let url = m.url { Link(destination: url) { row } } else { row }
    }
}

struct MomentRow: View {
    var moment: Moment
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: moment.kind == .happening ? "bolt.fill" : "eye.fill")
                .foregroundStyle(moment.kind == .happening ? Theme.hot : Theme.accent)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(moment.title).font(.subheadline.weight(.semibold))
                Text(moment.body).font(.footnote).foregroundStyle(Theme.muted)
                Text(moment.date, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(Theme.muted.opacity(0.7))
            }
        }
        .card()
    }
}

struct ModeSheet: View {
    @Environment(Watcher.self) private var watcher
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("What are you up to?").font(.title2.weight(.bold))
                ModeGrid(selected: watcher.mode) { watcher.mode = $0; dismiss() }
            }
            .padding(20)
        }
        .presentationBackground(Theme.bg)
    }
}
