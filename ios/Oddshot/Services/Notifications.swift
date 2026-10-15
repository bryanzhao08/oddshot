import Foundation
import UserNotifications
import BackgroundTasks

enum Prefs {
    static let sound = "soundEnabled"
    static let haptics = "hapticsEnabled"
    static let notifyAll = "notifyAllMajor"
    static let lastSeenAlert = "lastSeenAlertAt"
    static let notifiedIds = "notifiedSpikeIds"
}

/// Local notifications for spikes that match a subscription.
enum Notifier {
    static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    @discardableResult
    static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    static func title(for spike: Spike) -> String { "Oddshot · \(spike.signedPoints) pts" }

    /// Posts a local notification once per spike id (dedupes SSE vs background refresh).
    static func post(_ spike: Spike) async {
        guard markNotified(spike.id) else { return }
        let content = UNMutableNotificationContent()
        content.title = title(for: spike)
        content.subtitle = [spike.live ? "LIVE" : nil, spike.category.label, Market.sourceLabel(spike.source)]
            .compactMap { $0 }.joined(separator: " · ")
        content.body = spike.plainEnglish
        if UserDefaults.standard.object(forKey: Prefs.sound) as? Bool ?? true { content.sound = .default }
        content.threadIdentifier = spike.marketId
        content.userInfo = ["marketId": spike.marketId, "url": spike.url?.absoluteString ?? ""]
        if spike.severity == .major { content.interruptionLevel = .timeSensitive }
        let req = UNNotificationRequest(identifier: "spike-\(spike.id)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(req)
    }

    /// Returns false if this spike id was already notified.
    private static func markNotified(_ id: String) -> Bool {
        let d = UserDefaults.standard
        var ids = d.stringArray(forKey: Prefs.notifiedIds) ?? []
        if ids.contains(id) { return false }
        ids.append(id)
        if ids.count > 300 { ids.removeFirst(ids.count - 300) }
        d.set(ids, forKey: Prefs.notifiedIds)
        return true
    }
}

/// Shows banners even while the app is in the foreground.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
    static let shared = NotificationDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification)
        async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}

/// Background polling of `/api/alerts`.
///
/// IMPORTANT: iOS decides when (and whether) BGAppRefreshTask runs — typically at most every
/// ~15 minutes and often much less, based on usage patterns, battery, and Low Power Mode.
/// This is a best-effort catch-up, not real-time delivery. For true closed-app push use a
/// subscription webhook of type `ntfy` (ntfy.sh app on the phone), or APNs — which requires
/// a paid Apple Developer account and a push-capable server.
enum BackgroundRefresh {
    static let identifier = "com.oddshot.app.refresh"

    static func schedule() {
        let req = BGAppRefreshTaskRequest(identifier: identifier)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(req) } catch {
            // Fails on Simulator and when Background App Refresh is disabled; nothing to do.
        }
    }

    /// Fetches recent alerts and notifies for matched ones newer than the last seen timestamp.
    static func run() async {
        schedule() // always chain the next refresh
        guard let api = APIClient.current, let spikes = try? await api.alerts(limit: 50) else { return }
        let d = UserDefaults.standard
        let lastSeen = d.object(forKey: Prefs.lastSeenAlert) as? Date ?? Date().addingTimeInterval(-3600)
        let fresh = spikes
            .filter { $0.detectedAt > lastSeen && !$0.matchedSubscriptions.isEmpty }
            .sorted { $0.detectedAt < $1.detectedAt }
        for s in fresh.suffix(5) { await Notifier.post(s) }
        if let newest = spikes.map(\.detectedAt).max() { d.set(max(newest, lastSeen), forKey: Prefs.lastSeenAlert) }
    }
}
