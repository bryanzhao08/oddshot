import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(Watcher.self) private var watcher
    @Environment(\.dismiss) private var dismiss
    @State private var status: UNAuthorizationStatus = .notDetermined

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Text("Notifications")
                        Spacer()
                        Text(status == .authorized ? "On" : "Off").foregroundStyle(status == .authorized ? Theme.up : Theme.down)
                    }
                    if status == .notDetermined {
                        Button("Allow notifications") { Task { _ = await Notifier.requestAuthorization(); await refresh() } }
                    } else if status == .denied {
                        Button("Turn on in iPhone Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                    Button("Send a test alert") { watcher.sendTest() }
                } footer: {
                    Text("👀 Heads-up: a big swing just became likely. ⚡ It's happening: the odds just jumped.")
                }

                Section("How it works") {
                    Text("Oddshot reads live Polymarket odds on your phone. A model trained on 889k past moments predicts which ones are about to swing.")
                    Text("Alerts are instant while the app is open. When it's closed, iOS lets it check in now and then (about every 15 min at best).")
                }
                .font(.footnote)
                .foregroundStyle(Theme.muted)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await refresh() }
        }
    }

    private func refresh() async { status = await Notifier.status() }
}
