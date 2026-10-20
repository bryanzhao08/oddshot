import SwiftUI

/// First launch: pick who you are, allow notifications, done.
struct OnboardingView: View {
    @Environment(Watcher.self) private var watcher
    @State private var picked: Mode?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Oddshot").font(Theme.display(40))
                    Text("Betting odds move before the big play, the breaking news, the price jump. Oddshot watches them and taps you on the shoulder.")
                        .foregroundStyle(Theme.soft)
                }
                .padding(.top, 28)

                Text("What are you up to?").font(.title3.weight(.semibold))
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
                        .padding(.vertical, 8)
                }
                .glassButton(prominent: true)
                .tint(Theme.ember)
                .disabled(picked == nil)
                Text("You can switch any time. Everything runs on your phone.")
                    .font(.footnote).foregroundStyle(Theme.soft).frame(maxWidth: .infinity)
            }
            .padding(20)
        }
        .foregroundStyle(Theme.mist)
        .background { HeatSky(heat: picked == nil ? 0.15 : 0.5) }
    }
}

struct ModeGrid: View {
    var selected: Mode?
    var onPick: (Mode) -> Void

    var body: some View {
        GlassGroup(spacing: 10) {
            ForEach(Mode.allCases) { m in
                Button { onPick(m) } label: {
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: m.symbol).font(.title2).frame(width: 34, height: 34)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(m.name).font(.headline)
                            Text(m.blurb).font(.subheadline).foregroundStyle(Theme.soft).multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 0)
                        if selected == m { Image(systemName: "checkmark.circle.fill").font(.title3) }
                    }
                    .foregroundStyle(Theme.mist)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glass(22, tint: selected == m ? Theme.ember.opacity(0.35) : nil, interactive: true)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected == m ? .isSelected : [])
            }
        }
    }
}
