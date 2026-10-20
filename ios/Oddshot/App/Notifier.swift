import Foundation
import UserNotifications
import BackgroundTasks

/// Local notifications + background refresh. No server or APNs account needed.
enum Notifier {
    static let refreshTaskId = "com.oddshot.app.refresh"

    static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    static func status() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    static func post(_ m: Moment) {
        let c = UNMutableNotificationContent()
        c.title = m.title
        c.body = m.body
        c.sound = .default
        c.interruptionLevel = m.kind == .happening ? .timeSensitive : .active
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: m.id, content: c, trigger: nil))
    }

    // MARK: background refresh

    static func scheduleRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }
}

/// Shows notifications as banners even while the app is open.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = NotificationDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
