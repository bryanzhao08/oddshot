import SwiftUI
import UserNotifications

@main
struct OddshotApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        UNUserNotificationCenter.current().delegate = NotificationDelegate.shared
        UserDefaults.standard.register(defaults: [Prefs.sound: true, Prefs.haptics: true,
                                                  Prefs.notifyTopShots: true, Prefs.notifyInsights: true,
                                                  Prefs.shotPersona: Persona.general.rawValue])
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            switch phase {
            case .active:
                model.start()
            case .inactive where !model.isRunning:
                // A system alert at launch can hold the scene in .inactive; don't sit offline behind it.
                model.start()
            case .background:
                model.stop()
                BackgroundRefresh.schedule()
            default:
                break
            }
        }
        // Registers the BGAppRefreshTask handler (identifier also listed in Info.plist).
        // iOS throttles these heavily; see BackgroundRefresh for details.
        .backgroundTask(.appRefresh(BackgroundRefresh.identifier)) {
            await BackgroundRefresh.run()
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    // `-initialTab N` launch argument (handy for screenshots / UI tests).
    @State private var tab = UserDefaults.standard.integer(forKey: "initialTab")

    var body: some View {
        TabView(selection: $tab) {
            ShotsView()
                .tabItem { Label("Shots", systemImage: "scope") }.tag(0)
            PulseView()
                .tabItem { Label("Pulse", systemImage: "waveform.path.ecg") }.tag(1)
            MoversView()
                .tabItem { Label("Movers", systemImage: "chart.line.uptrend.xyaxis") }.tag(2)
            SearchView()
                .tabItem { Label("Search", systemImage: "magnifyingglass") }.tag(3)
            AlertsView()
                .tabItem { Label("Alerts", systemImage: "bell.badge.fill") }.tag(4)
                .badge(model.subscriptions.count)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }.tag(5)
        }
        .overlay(alignment: .top) {
            if let t = model.toast {
                Toast(text: t)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.4), value: model.toast)
        .task {
            // Ask in context: only prompt once the user has alerts that could notify them.
            await model.loadSubscriptions()
            // `-skipNotificationPrompt YES` keeps the system alert out of screenshots / UI tests.
            if !model.subscriptions.isEmpty, !UserDefaults.standard.bool(forKey: "skipNotificationPrompt"), await Notifier.authorizationStatus() == .notDetermined {
                await Notifier.requestAuthorization()
            }
        }
    }
}
