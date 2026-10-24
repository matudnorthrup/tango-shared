import SwiftUI
import UserNotifications
import BackgroundTasks
import TangoDeskKit

@MainActor @Observable final class AppModel {
    static let shared = AppModel()
    var baseText: String
    var currentURL: URL?
    var navigationID = UUID()
    var error: String?
    var queued: [AnswerQueue.Entry] = []
    var queue: AnswerQueue?
    var pendingDecision: String?
    private var token: String? { UserDefaults.standard.string(forKey: "deviceToken") }
    var address: DeskAddress? { try? DeskAddress(baseText) }
    static var refreshID: String { (Bundle.main.bundleIdentifier ?? "org.example.TangoDesk") + ".refresh" }
    private init() {
        baseText = UserDefaults.standard.string(forKey: "deskURL") ?? (Bundle.main.object(forInfoDictionaryKey: "DeskDefaultURL") as? String ?? "")
        if let address { currentURL = address.base }
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            queue = try AnswerQueue(file: support.appendingPathComponent("answers.json"))
        } catch { self.error = "Cannot read saved answers: \(error.localizedDescription). They have not been deleted." }
    }
    func setAddress(_ value: String) {
        do {
            let next = try DeskAddress(value)
            baseText = next.base.absoluteString
            UserDefaults.standard.set(baseText, forKey: "deskURL")
            currentURL = pendingDecision.flatMap(next.decision) ?? next.base
            error = nil
            Task { await registerToken(); await retry() }
        } catch { self.error = error.localizedDescription }
    }
    func open(_ decision: String) {
        pendingDecision = decision
        if let url = address?.decision(decision) { navigate(to: url) }
    }
    func navigate(to url: URL) { currentURL = url; navigationID = UUID() }
    func permissions() async {
        do {
            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            if allowed { UIApplication.shared.registerForRemoteNotifications() }
        } catch { self.error = "Notifications: \(error.localizedDescription)" }
    }
    func receivedToken(_ data: Data) {
        UserDefaults.standard.set(data.map { String(format: "%02x", $0) }.joined(), forKey: "deviceToken")
        Task { await registerToken() }
    }
    func registerToken() async {
        guard let address, let token, let bundleId = Bundle.main.bundleIdentifier else { return }
        do {
            let environment = try PushEnvironment.registration(forEntitlement: Bundle.main.object(forInfoDictionaryKey: "APNsEnvironment") as? String ?? "")
            let deskID = try await DeskClient(address: address).register(DeviceRegistration(token: token, bundleId: bundleId, environment: environment))
            // A notification from a previously configured desk must never answer a same-numbered brief on this desk.
            UserDefaults.standard.set(deskID, forKey: "registeredDeskID")
            UserDefaults.standard.set(address.base.absoluteString, forKey: "registeredAddress")
        }
        catch { self.error = "Push registration will retry: \(error.localizedDescription)" }
    }
    func retry() async {
        guard let queue else { return }
        do {
            try await queue.drain(send: { entry in try await DeskClient(address: entry.address).send(entry.command) }, refused: { entry in
                await Self.notifyFailure(decision: entry.decisionId, reason: entry.failure ?? "The desk refused the answer.", sourceAddress: entry.address)
            })
            queued = await queue.all()
        } catch { self.error = "Saved answers need attention: \(error.localizedDescription)" }
        scheduleRefresh()
    }
    func action(_ identifier: String, payload: Data) async {
        do {
            let push = try JSONDecoder().decode(DecisionPush.self, from: payload)
            guard identifier != UNNotificationDismissActionIdentifier else { return }
            guard push.belongs(to: address, registeredDeskID: UserDefaults.standard.string(forKey: "registeredDeskID"),
                               registeredAddress: UserDefaults.standard.string(forKey: "registeredAddress")) else {
                let reason = "This notification is from another desk. Check your desk in Settings."
                self.error = reason
                await Self.notifyFailure(decision: "", reason: reason, title: "Notification belongs to another desk")
                return
            }
            if identifier == UNNotificationDefaultActionIdentifier || identifier == "open" { open(push.decisionId); await retry(); return }
            guard let queue, let address else { throw DeskError.refused("Open the app and set up your desk before answering.") }
            let command: DeskCommand
            if identifier == "snooze" { command = push.snooze() }
            else if identifier.hasPrefix("option-"), let index = Int(identifier.dropFirst(7)) { command = try push.command(option: index) }
            else { throw DeskError.refused("Unknown notification action. Open the decision.") }
            try await queue.enqueue(address: address, command: command, decisionId: push.decisionId)
            await retry()
            if await queue.all().contains(where: { $0.id == command.id && $0.failure == nil }) {
                await Self.notifyFailure(decision: push.decisionId, reason: "Your answer is saved on this phone and will retry automatically.", title: "Answer saved, will send when the desk is reachable")
            }
        } catch {
            self.error = "Answer did not go through: \(error.localizedDescription)"
            let decision = (try? JSONDecoder().decode(DecisionPush.self, from: payload).decisionId) ?? ""
            await Self.notifyFailure(decision: decision, reason: error.localizedDescription)
        }
    }
    static func notifyFailure(decision: String, reason: String, title: String = "Answer didn't go through", sourceAddress: DeskAddress? = nil) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = reason
        content.categoryIdentifier = decision.isEmpty ? "decision-info" : "decision-failure"
        let source = sourceAddress ?? shared.address
        let registeredAddress = UserDefaults.standard.string(forKey: "registeredAddress")
        let deskID = source?.base.absoluteString == registeredAddress ? UserDefaults.standard.string(forKey: "registeredDeskID") : nil
        content.userInfo = ["decisionId": decision, "deskId": deskID ?? "", "deskAddress": source?.base.absoluteString ?? ""]
        #if !targetEnvironment(simulator)
        content.sound = .default
        #endif
        do { try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) }
        catch { shared.error = "Answer needs attention: \(reason). Notification could not be shown." }
    }
    func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(request) } catch { /* iOS may disable background refresh; launch/actions still retry. */ }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        var categories: Set<UNNotificationCategory> = []
        let open = UNNotificationAction(identifier: "open", title: "Open", options: [.foreground])
        for count in 1...3 {
            for locked in [false, true] {
                var actions = (0..<count).map { UNNotificationAction(identifier: "option-\($0)", title: String(UnicodeScalar(65 + $0)!), options: locked ? [.authenticationRequired] : []) }
                actions.append(UNNotificationAction(identifier: "snooze", title: "Snooze 1 hour", options: locked ? [.authenticationRequired] : []))
                // iOS displays at most four custom actions. The default tap always opens the brief.
                if count < 3 { actions.append(open) }
                categories.insert(UNNotificationCategory(identifier: "decision-\(count)\(locked ? "-locked" : "")", actions: actions, intentIdentifiers: []))
            }
        }
        for locked in [false, true] {
            categories.insert(UNNotificationCategory(identifier: "decision-open\(locked ? "-locked" : "")", actions: [UNNotificationAction(identifier: "snooze", title: "Snooze 1 hour", options: locked ? [.authenticationRequired] : []), open], intentIdentifiers: []))
        }
        categories.insert(UNNotificationCategory(identifier: "decision-failure", actions: [open], intentIdentifiers: []))
        center.setNotificationCategories(categories)
        BGTaskScheduler.shared.register(forTaskWithIdentifier: AppModel.refreshID, using: nil) { task in
            let work = Task { @MainActor in await AppModel.shared.retry(); task.setTaskCompleted(success: true) }
            task.expirationHandler = { work.cancel() }
        }
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        AppModel.shared.receivedToken(deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        AppModel.shared.error = "Push registration: \(error.localizedDescription)"
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void) {
        #if targetEnvironment(simulator)
        Task { @MainActor in completionHandler([.banner, .list]) }
        #else
        Task { @MainActor in completionHandler([.banner, .list, .sound]) }
        #endif
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let info = response.notification.request.content.userInfo
        let identifier = response.actionIdentifier
        let informationOnly = response.notification.request.content.categoryIdentifier == "decision-info"
        let openOnly = response.notification.request.content.categoryIdentifier == "decision-failure"
        let decision = info["decisionId"] as? String
        let noticeDeskID = info["deskId"] as? String
        let noticeAddress = info["deskAddress"] as? String
        let data = try? JSONSerialization.data(withJSONObject: info)
        // UIKit performs scene restoration from this completion; keep it on the main actor.
        Task { @MainActor in
            defer { completionHandler() }
            if informationOnly || identifier == UNNotificationDismissActionIdentifier { return }
            if openOnly, let decision {
                let model = AppModel.shared
                guard let address = model.address,
                      noticeDeskID == UserDefaults.standard.string(forKey: "registeredDeskID"),
                      noticeAddress == address.base.absoluteString,
                      address.base.absoluteString == UserDefaults.standard.string(forKey: "registeredAddress") else {
                    let reason = "This notification is from another desk. Check your desk in Settings."
                    model.error = reason
                    await AppModel.notifyFailure(decision: "", reason: reason, title: "Notification belongs to another desk")
                    return
                }
                model.open(decision); await model.retry(); return
            }
            guard let data else {
                await AppModel.notifyFailure(decision: decision ?? "", reason: "The notification could not be read. Open the desk.")
                return
            }
            await AppModel.shared.action(identifier, payload: data)
        }
    }
}
