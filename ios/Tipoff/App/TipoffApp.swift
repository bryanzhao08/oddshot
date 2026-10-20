import SwiftUI
import UserNotifications

@main
struct TipoffApp: App {
    @Environment(\.scenePhase) private var phase
    @State private var watcher = Watcher.shared

    init() {
        UNUserNotificationCenter.current().delegate = NotificationDelegate.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(watcher)
                .preferredColorScheme(.dark)
                .tint(Theme.ember)
        }
        .onChange(of: phase) { _, phase in
            switch phase {
            case .active:
                watcher.start()
            case .background:
                watcher.stop()
                Notifier.scheduleRefresh()
            default: break
            }
        }
        .backgroundTask(.appRefresh(Notifier.refreshTaskId)) {
            Notifier.scheduleRefresh()
            await Watcher.shared.tick(background: true)
        }
    }
}

struct RootView: View {
    @Environment(Watcher.self) private var watcher

    var body: some View {
        if watcher.onboarded {
            HomeView()
        } else {
            OnboardingView()
        }
    }
}
