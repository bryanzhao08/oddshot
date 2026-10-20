import SwiftUI

/// First launch: pick who you are, allow notifications, done.
struct OnboardingView: View {
    @Environment(Watcher.self) private var watcher
    @State private var picked: Mode?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Oddshot").font(.system(.largeTitle, design: .rounded).weight(.heavy)).foregroundStyle(Theme.accent)
                    Text("Never miss the moment.").font(.title2.weight(.bold))
                    Text("Betting odds move before the big play, the breaking news, the price jump. Oddshot watches them and taps you on the shoulder.")
                        .foregroundStyle(Theme.muted)
                }
                .padding(.top, 24)

                Text("What are you up to?").font(.headline).padding(.top, 8)
                ModeGrid(selected: picked) { picked = $0 }

                Button {
                    guard let picked else { return }
                    watcher.mode = picked
                    Task {
                        _ = await Notifier.requestAuthorization()
                        watcher.onboarded = true
                    }
                } label: {
                    Text(picked == nil ? "Pick one to start" : "Start watching")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(picked == nil ? Theme.line : Theme.accent, in: Capsule())
                        .foregroundStyle(picked == nil ? Theme.muted : Theme.accentInk)
                }
                .disabled(picked == nil)
                Text("You can switch any time. Everything runs on your phone.")
                    .font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity)
            }
            .padding(20)
        }
        .background(Theme.bg.ignoresSafeArea())
    }
}

struct ModeGrid: View {
    var selected: Mode?
    var onPick: (Mode) -> Void

    var body: some View {
        VStack(spacing: 10) {
            ForEach(Mode.allCases) { m in
                Button { onPick(m) } label: {
                    HStack(alignment: .top, spacing: 14) {
                        Text(m.emoji).font(.system(size: 30))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(m.name).font(.headline).foregroundStyle(.white)
                            Text(m.blurb).font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 0)
                        if selected == m { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.accent).font(.title3) }
                    }
                    .card(highlight: selected == m ? Theme.accent : nil)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
