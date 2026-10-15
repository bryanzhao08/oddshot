import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @AppStorage(Prefs.sound) private var soundOn = true
    @AppStorage(Prefs.haptics) private var hapticsOn = true
    @State private var urlText = ServerConfig.current
    @State private var testing = false
    @State private var health: Health?
    @State private var healthError: String?
    @State private var notifStatus: UNAuthorizationStatus = .notDetermined

    var body: some View {
        NavigationStack {
            Form {
                serverSection
                notificationsSection
                Section("Feedback") {
                    Toggle(isOn: $soundOn) { Label("Sound on major spikes", systemImage: "speaker.wave.2.fill") }
                    Toggle(isOn: $hapticsOn) { Label("Haptics on major spikes", systemImage: "iphone.radiowaves.left.and.right") }
                }
                .tint(Theme.accent)
                ntfySection
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Wordmark()
                        Text("The odds move before the headlines do.")
                            .font(.footnote).foregroundStyle(Theme.dim)
                        Text("Oddshot watches Polymarket and Kalshi for sudden probability spikes — the crowd reacting to something happening right now.")
                            .font(.footnote).foregroundStyle(Theme.faint)
                    }
                    .padding(.vertical, 4)
                }
            }
            .scrollContentBackground(.hidden)
            .oddshotScreen()
            .navigationTitle("Settings")
            .task { notifStatus = await Notifier.authorizationStatus() }
        }
    }

    private var serverSection: some View {
        Section {
            TextField("http://localhost:8787", text: $urlText)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(Theme.mono(14))
                .onSubmit(apply)
            HStack {
                Button("Save & reconnect", action: apply)
                    .disabled(ServerConfig.url(from: urlText) == nil)
                Spacer()
                Button {
                    Task { await testConnection() }
                } label: {
                    if testing { ProgressView() } else { Text("Test connection") }
                }
                .buttonStyle(.bordered)
            }
            .buttonStyle(.borderless)
            if let health {
                VStack(alignment: .leading, spacing: 6) {
                    Label(health.ok ? "Connected" : "Server reports a problem",
                          systemImage: health.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(health.ok ? Theme.up : Theme.notable)
                        .font(.subheadline.bold())
                    Text("\(health.marketCount) markets" + (health.lastPollAt.map { " · polled \($0.formatted(.relative(presentation: .named)))" } ?? ""))
                        .font(Theme.mono(12)).foregroundStyle(Theme.dim)
                    ForEach(health.sources.keys.sorted(), id: \.self) { k in
                        if let s = health.sources[k] {
                            HStack {
                                Circle().fill(s.ok ? Theme.up : Theme.down).frame(width: 7, height: 7)
                                Text(Market.sourceLabel(k)).font(.footnote.bold())
                                Text(s.ok ? "\(s.count) markets" : (s.error ?? "error"))
                                    .font(Theme.mono(11)).foregroundStyle(Theme.dim).lineLimit(1)
                            }
                        }
                    }
                }
            }
            if let healthError {
                Label(healthError, systemImage: "xmark.octagon.fill")
                    .font(.footnote).foregroundStyle(Theme.down)
            }
        } header: {
            Text("Server")
        } footer: {
            Text("The Simulator can use localhost. On a real iPhone, use your Mac’s LAN address, e.g. http://192.168.1.20:8787.")
        }
    }

    private var notificationsSection: some View {
        Section {
            HStack {
                Label("Notifications", systemImage: "bell.badge.fill")
                Spacer()
                Text(statusLabel).foregroundStyle(statusColor).font(.subheadline.bold())
            }
            switch notifStatus {
            case .notDetermined:
                Button("Allow notifications") {
                    Task {
                        await Notifier.requestAuthorization()
                        notifStatus = await Notifier.authorizationStatus()
                    }
                }
            case .denied:
                Button("Open iOS Settings") {
                    if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) }
                }
            default:
                EmptyView()
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("You’re notified when a spike matches one of your alerts. While the app is open this is instant via the live stream; in the background iOS only lets Oddshot check occasionally.")
        }
    }

    private var ntfySection: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Label("Instant push when Oddshot is closed", systemImage: "iphone.gen3.radiowaves.left.and.right")
                    .font(.subheadline.bold())
                step(1, "Install the free **ntfy** app from the App Store.")
                step(2, "Subscribe to a hard-to-guess topic, e.g. `oddshot-k9x2q`.")
                step(3, "In **Alerts**, edit an alert → enable *Send to webhook* → type **ntfy.sh** → URL `https://ntfy.sh/oddshot-k9x2q`.")
                step(4, "Tap *Send test alert*. Your phone buzzes even with Oddshot closed.")
                Text("Why? True background push from Oddshot itself needs Apple Push Notification service, which requires a paid Apple Developer account. ntfy gets you there for free.")
                    .font(.caption).foregroundStyle(Theme.faint)
            }
            .padding(.vertical, 4)
            Link(destination: URL(string: "https://ntfy.sh")!) {
                Label("ntfy.sh", systemImage: "arrow.up.right.square")
            }
        } header: {
            Text("Phone push via ntfy")
        }
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(n)")
                .font(Theme.mono(11, .heavy))
                .foregroundStyle(.black)
                .frame(width: 20, height: 20)
                .background(Theme.accent, in: Circle())
            Text(text).font(.footnote).foregroundStyle(.white.opacity(0.85))
        }
    }

    private var statusLabel: String {
        switch notifStatus {
        case .authorized: "On"
        case .provisional, .ephemeral: "Quiet"
        case .denied: "Off"
        default: "Not set"
        }
    }
    private var statusColor: Color {
        switch notifStatus {
        case .authorized, .provisional, .ephemeral: Theme.up
        case .denied: Theme.down
        default: Theme.dim
        }
    }

    private func apply() {
        guard ServerConfig.url(from: urlText) != nil else { return }
        model.applyServerURL(urlText)
        urlText = model.serverURL
        Task { await testConnection() }
    }

    private func testConnection() async {
        testing = true; healthError = nil; health = nil
        defer { testing = false }
        guard let url = ServerConfig.url(from: urlText) else { healthError = APIError.badURL.localizedDescription; return }
        do { health = try await APIClient(baseURL: url).health() } catch { healthError = error.localizedDescription }
    }
}
