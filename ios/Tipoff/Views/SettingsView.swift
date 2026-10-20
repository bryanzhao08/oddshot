import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(Watcher.self) private var watcher
    @Environment(\.dismiss) private var dismiss
    @State private var status: UNAuthorizationStatus = .notDetermined
    @State private var xToken = ""
    @State private var xSaved = Keychain.read("xBearerToken") != nil

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
                    Toggle("Only matches I follow", isOn: Bindable(watcher).onlyFollowed)
                    Button("Send a test alert") { watcher.sendTest() }
                } footer: {
                    Text("You'll hear about must-see moments (tiebreaks, overtime, match point), heads-ups when the odds are likely to jump soon, and jumps the moment they happen, like \"Ann Li jumped from 42% to 60% in 3 min\".")
                }

                Section {
                    if xSaved {
                        HStack {
                            Text("X connected")
                            Spacer()
                            Button("Remove", role: .destructive) {
                                Keychain.write("xBearerToken", nil)
                                xSaved = false
                                watcher.xTokenChanged()
                            }
                        }
                    } else {
                        SecureField("X API bearer token", text: $xToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Connect X") {
                            Keychain.write("xBearerToken", xToken.trimmingCharacters(in: .whitespacesAndNewlines))
                            xToken = ""
                            xSaved = true
                            watcher.xTokenChanged()
                        }
                        .disabled(xToken.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                } header: {
                    Text("Live posts from X")
                } footer: {
                    Text("Shows what people are posting about your top pick and alerts you when chatter suddenly spikes. Needs a bearer token from developer.x.com (X's paid API). It's stored in your iPhone's Keychain and only sent to X.")
                }

                Section("How it works") {
                    Text("Tipoff reads live Polymarket odds on your phone. A model trained on 889k past moments predicts which ones are about to swing, and ESPN's live scores explain what's happening on the field.")
                    Text("Alerts are instant while the app is open. When it's closed, iOS lets it check in now and then (about every 15 min at best).")
                }
                .font(.footnote)
                .foregroundStyle(Theme.soft)
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await refresh() }
        }
        .sheetBackground()
    }

    private func refresh() async { status = await Notifier.status() }
}
